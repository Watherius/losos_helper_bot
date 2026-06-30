from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Text, JSON, func
from pgvector.sqlalchemy import Vector
from app.db import Base

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True) # WhatsApp JID
    name = Column(String, nullable=True)
    phone = Column(String, nullable=True)
    created_at = Column(DateTime, server_default=func.now())

class Group(Base):
    __tablename__ = "groups"

    id = Column(String, primary_key=True, index=True) # Group JID
    name = Column(String, nullable=True)
    created_at = Column(DateTime, server_default=func.now())

class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    wa_message_id = Column(String, unique=True, index=True, nullable=True)
    chat_id = Column(String, index=True, nullable=False)
    sender_id = Column(String, index=True, nullable=False)
    sender_name = Column(String, nullable=True)
    text = Column(Text, nullable=True)
    type = Column(String, default="text") # text, image, audio, video, document, reaction, etc.
    file_path = Column(String, nullable=True)
    reply_to = Column(String, nullable=True) # Parent WhatsApp message ID
    timestamp = Column(DateTime, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

class ResponseLog(Base):
    __tablename__ = "response_logs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    chat_id = Column(String, index=True, nullable=False)
    sender_id = Column(String, index=True, nullable=False)
    user_query = Column(Text, nullable=False)
    response_text = Column(Text, nullable=False)
    confidence = Column(Float, nullable=False)
    processing_time = Column(Float, nullable=False) # In seconds
    tokens_used = Column(Integer, default=0)
    knowledge_sources = Column(JSON, nullable=True) # List of source documents/chunks used
    created_at = Column(DateTime, server_default=func.now())

class KnowledgeBase(Base):
    __tablename__ = "knowledge_base"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    filename = Column(String, nullable=False)
    content_chunk = Column(Text, nullable=False)
    embedding = Column(Vector(1536), nullable=False) # OpenAI text-embedding-3-small dimension
    created_at = Column(DateTime, server_default=func.now())
