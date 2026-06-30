import os
import shutil
from fastapi import FastAPI, Depends, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from contextlib import asynccontextmanager

from app.db import init_db, get_db
from app.redis_client import init_redis, close_redis
from app.services.buffer import add_to_buffer
from app.services.rag import rag_service
from app.models import KnowledgeBase
from sqlalchemy import select, delete

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize Database and Redis
    print("Initializing Database...")
    await init_db()
    print("Initializing Redis client...")
    init_redis()
    
    # Ensure local upload directories exist
    os.makedirs("/app/knowledge_base_docs", exist_ok=True)
    os.makedirs("/app/shared_media", exist_ok=True)
    
    yield
    
    # Shutdown: Close connections
    print("Closing connections...")
    await close_redis()

app = FastAPI(
    title="WhatsApp AI Backend",
    description="AI Backend containing buffering, queues, RAG, and OpenAI integration",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/webhook")
async def webhook_endpoint(payload: dict):
    """
    Webhook received from the Node.js WhatsApp Gateway.
    Simply passes the message payload to the buffer service.
    """
    chat_id = payload.get("chat_id")
    sender_id = payload.get("sender_id")
    
    if not chat_id or not sender_id:
        raise HTTPException(status_code=422, detail="Отсутствует chat_id или sender_id")
        
    await add_to_buffer(chat_id, sender_id, payload)
    return {"status": "success", "message": "Сообщение успешно добавлено в буфер"}

@app.post("/admin/upload-kb")
async def upload_knowledge_base_document(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db)
):
    """
    Admin endpoint to upload documents (PDF, DOCX, XLSX, TXT, MD) 
    and index them into the RAG vector database.
    """
    filename = file.filename
    temp_dir = "/app/knowledge_base_docs"
    file_path = os.path.join(temp_dir, filename)
    
    try:
        # Save uploaded file
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Ingest document
        await rag_service.ingest_document(db, file_path, filename)
        
        return {"status": "success", "message": f"Документ '{filename}' успешно проиндексирован в базе знаний."}
        
    except Exception as e:
        # Clean up file in case of failure
        if os.path.exists(file_path):
            os.remove(file_path)
        raise HTTPException(status_code=500, detail=f"Ошибка индексации документа: {str(e)}")

@app.get("/admin/kb-files")
async def list_knowledge_base_files(db: AsyncSession = Depends(get_db)):
    """
    List all distinct document filenames indexed in the knowledge base.
    """
    try:
        stmt = select(KnowledgeBase.filename).distinct()
        result = await db.execute(stmt)
        files = result.scalars().all()
        return {"files": files}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Не удалось получить список файлов: {str(e)}")

@app.delete("/admin/kb-files/{filename}")
async def delete_knowledge_base_file(
    filename: str,
    db: AsyncSession = Depends(get_db)
):
    """
    Delete a document and all its chunks/embeddings from the knowledge base.
    """
    try:
        # Delete entries from PostgreSQL
        stmt = delete(KnowledgeBase).where(KnowledgeBase.filename == filename)
        await db.execute(stmt)
        await db.commit()
        
        # Remove physical file if exists
        file_path = os.path.join("/app/knowledge_base_docs", filename)
        if os.path.exists(file_path):
            os.remove(file_path)
            
        return {"status": "success", "message": f"Документ '{filename}' успешно удален."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка удаления документа: {str(e)}")

from pydantic import BaseModel

class PromptUpdate(BaseModel):
    prompt: str

@app.get("/admin/prompt")
async def get_current_prompt():
    """
    Get the current custom prompt or return the default prompt.
    """
    from app.services.openai_service import PROMPT_FILE, DEFAULT_PROMPT
    if os.path.exists(PROMPT_FILE):
        try:
            with open(PROMPT_FILE, "r", encoding="utf-8") as f:
                return {"prompt": f.read()}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Ошибка чтения промпта: {str(e)}")
    return {"prompt": DEFAULT_PROMPT}

@app.post("/admin/prompt")
async def update_prompt(payload: PromptUpdate):
    """
    Update the prompt stored in prompt.txt.
    """
    from app.services.openai_service import PROMPT_FILE
    try:
        # Ensure directory exists
        os.makedirs(os.path.dirname(PROMPT_FILE), exist_ok=True)
        with open(PROMPT_FILE, "w", encoding="utf-8") as f:
            f.write(payload.prompt)
        return {"status": "success", "message": "Промпт успешно обновлен."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка сохранения промпта: {str(e)}")

@app.get("/health")
def health_check():
    return {"status": "healthy"}
