import os
import json
import time
import httpx
from typing import List, Dict, Optional, Any
from sqlalchemy import select, or_
from datetime import datetime

from app.db import async_session_maker
from app.models import User, Group, Message, ResponseLog, KnowledgeBase
from app.config import settings
from app.services.openai_service import openai_service
from app.services.rag import rag_service

async def get_or_create_user(db, sender_id: str, name: str, phone: str):
    stmt = select(User).where(User.id == sender_id)
    res = await db.execute(stmt)
    user = res.scalar_one_or_none()
    if not user:
        user = User(id=sender_id, name=name, phone=phone)
        db.add(user)
        await db.commit()
    return user

async def get_or_create_group(db, chat_id: str, chat_name: str):
    if not chat_id.endswith('@g.us'):
        return None
    stmt = select(Group).where(Group.id == chat_id)
    res = await db.execute(stmt)
    group = res.scalar_one_or_none()
    if not group:
        group = Group(id=chat_id, name=chat_name)
        db.add(group)
        await db.commit()
    return group

async def get_fallback_answer(db, query: str) -> str:
    """
    Fallback answering mechanism using keyword-based text search.
    Used when OpenAI is unavailable.
    """
    # Extract keywords (words longer than 3 chars)
    words = [w for w in query.lower().split() if len(w) > 3]
    if words:
        conditions = [KnowledgeBase.content_chunk.ilike(f"%{word}%") for word in words]
        stmt = select(KnowledgeBase).where(or_(*conditions)).limit(2)
        res = await db.execute(stmt)
        chunks = res.scalars().all()
        
        if chunks:
            instructions = "\n\n".join([f"- {chunk.content_chunk}" for chunk in chunks])
            return (
                "Временные неполадки сети. Найдена подходящая инструкция:\n\n"
                f"{instructions}\n\n"
                "Если это не решило проблему, вопрос передан специалисту."
            )
            
    return "Не удалось определить решение. Передаю вопрос специалисту."

async def send_reply_to_whatsapp(chat_id: str, text: str, reply_to: Optional[str] = None, mention_jid: Optional[str] = None):
    """
    Sends the response back to WhatsApp Gateway.
    """
    try:
        url = f"{settings.GATEWAY_URL}/send"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "reply_to": reply_to,
            "mention_jid": mention_jid
        }
        # Post to Fastify gateway
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, timeout=10.0)
        if response.status_code != 200:
            print(f"Failed to send to WA Gateway. Status code: {response.status_code}, detail: {response.text}")
    except Exception as e:
        print(f"Error calling WA Gateway at {url}: {e}")

async def process_message_job(chat_id: str, sender_id: str, messages_batch: List[dict]):
    """
    Core processor logic:
    1. Persist batch messages in PostgreSQL
    2. Extract audio, image, document content if present
    3. Retrieve context (user history)
    4. RAG search
    5. OpenAI answering (with confidence threshold + fallback templates)
    6. Response log
    7. Send reply
    """
    start_time = time.time()
    
    async with async_session_maker() as db:
        # 1. Resolve user & group
        first_msg = messages_batch[0]
        await get_or_create_user(db, sender_id, first_msg.get("sender_name", ""), first_msg.get("sender_phone", ""))
        await get_or_create_group(db, chat_id, first_msg.get("chat_name", ""))
        
        # Save all messages in batch to DB
        db_messages = []
        for msg in messages_batch:
            ts_str = msg.get("timestamp")
            # Parse ISO timestamp
            try:
                if ts_str:
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    dt = dt.replace(tzinfo=None)
                else:
                    dt = datetime.now()
            except Exception:
                dt = datetime.now()

            db_msg = Message(
                wa_message_id=msg.get("message_id"),
                chat_id=chat_id,
                sender_id=sender_id,
                sender_name=msg.get("sender_name"),
                text=msg.get("text"),
                type=msg.get("type", "text"),
                file_path=msg.get("file_path"),
                reply_to=msg.get("reply_to"),
                timestamp=dt
            )
            db.add(db_msg)
            db_messages.append(db_msg)
            
        await db.commit()
        
        # 2. Extract contents and build combined prompt
        texts = []
        knowledge_sources = []
        for msg in messages_batch:
            msg_type = msg.get("type")
            msg_text = msg.get("text", "")
            
            if msg_type == "text":
                if msg_text:
                    texts.append(msg_text)
            elif msg_type == "image":
                file_path = msg.get("file_path")
                caption = msg.get("caption", "")
                if file_path:
                    desc = await openai_service.describe_image(file_path)
                    texts.append(f"[Изображение: {desc}]")
                if caption:
                    texts.append(caption)
            elif msg_type == "audio":
                file_path = msg.get("file_path")
                if file_path:
                    transcription = await openai_service.transcribe_audio(file_path)
                    texts.append(f"[Голосовое: {transcription}]")
            elif msg_type == "document":
                file_path = msg.get("file_path")
                caption = msg.get("caption", "")
                if file_path:
                    try:
                        doc_content = rag_service.extract_text(file_path)
                        # Limit to avoid token limit overflow
                        texts.append(f"[Документ '{os.path.basename(file_path)}': {doc_content[:1500]}]")
                    except Exception as e:
                        texts.append(f"[Ошибка извлечения текста из файла: {e}]")
                if caption:
                    texts.append(caption)
            elif msg_type == "reaction":
                # Save reaction in logs, but usually don't answer
                pass
                
        user_query = "\n\n".join(texts)
        if not user_query.strip():
            # Nothing to answer (e.g. only reactions or empty message)
            return

        # 3. Retrieve user-specific history (segmented by chat_id AND sender_id)
        stmt = (
            select(ResponseLog)
            .where(ResponseLog.chat_id == chat_id, ResponseLog.sender_id == sender_id)
            .order_by(ResponseLog.created_at.desc())
            .limit(5)
        )
        res = await db.execute(stmt)
        history_logs = list(res.scalars().all())
        history_logs.reverse() # Back to chronological order
        
        history_formatted: List[Dict[str, str]] = []
        for log in history_logs:
            history_formatted.append({"role": "user", "content": str(log.user_query)})
            history_formatted.append({"role": "assistant", "content": str(log.response_text)})
            
        # 4. Search Knowledge Base (RAG)
        kb_chunks = await rag_service.retrieve_similar_chunks(db, user_query)
        kb_texts = []
        for chunk in kb_chunks:
            kb_texts.append(str(chunk.content_chunk))
            knowledge_sources.append(chunk.filename)
            
        # Remove duplicate filenames
        knowledge_sources = list(set(knowledge_sources))
        
        # 5. Call OpenAI with fallback templates
        response_text = ""
        confidence = 0.0
        tokens_used = 0
        
        try:
            response_text, confidence, tokens_used = await openai_service.generate_answer(
                query=user_query,
                history=history_formatted,
                kb_chunks=kb_texts
            )
            
            # Confidence check
            if confidence < settings.CONFIDENCE_THRESHOLD:
                print(f"Confidence score {confidence} is below threshold {settings.CONFIDENCE_THRESHOLD}. Using fallback transfer.")
                response_text = "Не удалось определить решение.\nПередаю вопрос специалисту."
                
        except Exception as e:
            print(f"OpenAI service failed, falling back to template responses. Error: {e}")
            response_text = await get_fallback_answer(db, user_query)
            confidence = 0.0
            
        processing_time = time.time() - start_time
        
        # 6. Log the response
        resp_log = ResponseLog(
            chat_id=chat_id,
            sender_id=sender_id,
            user_query=user_query,
            response_text=response_text,
            confidence=confidence,
            processing_time=processing_time,
            tokens_used=tokens_used,
            knowledge_sources=knowledge_sources
        )
        db.add(resp_log)
        await db.commit()
        
        # 7. Send the response back to WhatsApp
        # Respond quoting the last message ID from the batch
        reply_to_id = messages_batch[-1].get("message_id")
        await send_reply_to_whatsapp(chat_id, response_text, reply_to_id, sender_id)
