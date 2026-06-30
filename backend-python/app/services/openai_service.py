import os
import base64
import time
from typing import List, Dict, Tuple, Optional
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from app.config import settings

# Structured output schemas
class AIResponse(BaseModel):
    response_text: str = Field(description="Ответ пользователю на основе предоставленных документов.")
    confidence: float = Field(
        description=(
            "Уровень уверенности в ответе от 0.0 до 1.0 на основе соответствия базе знаний. "
            "Установите значение строго меньше 0.5 (например, 0.0), если сообщение пользователя является приветствием, "
            "флудом, оскорблением, бессмысленным набором слов, или не содержит конкретного вопроса, "
            "на который в предоставленных документах базы знаний есть прямой ответ."
        )
    )

PROMPT_FILE = "/app/knowledge_base_docs/prompt.txt"
DEFAULT_PROMPT = (
    "Вы — ИИ-ассистент службы автоматизированной поддержки клиентов. "
    "Отвечайте пользователю строго на основе предоставленных документов из Базы Знаний.\n"
    "ПРАВИЛА:\n"
    "1. База Знаний — ваш единственный источник истины.\n"
    "2. Если предоставленные документы содержат точный ответ на вопрос пользователя, ответьте подробно и вежливо. Установите высокий уровень уверенности (confidence > 0.8).\n"
    "3. Если в документах нет информации для ответа на вопрос или она неполная, установите confidence < 0.5. Напишите, что вы не смогли найти точное решение в инструкциях.\n"
    "4. Категорически запрещено выдумывать шаги, адреса, телефоны или инструкции, которых нет в Базе Знаний.\n"
    "5. Принимайте во внимание историю переписки для понимания контекста.\n"
    "6. Обязательно сохраняйте и используйте форматирование текста для WhatsApp (жирный шрифт, курсив), как в Базе Знаний. Для жирного шрифта выделяйте ключевые слова, кнопки, названия разделов и контакты с помощью одиночных звездочек: *текст* (например, *Настройки*, *Обновить*, *Марии*). Категорически запрещено использовать двойные звездочки (**текст**), так как WhatsApp их не поддерживает. Для курсива используйте нижние подчеркивания: _текст_."
)

def get_system_prompt() -> str:
    if os.path.exists(PROMPT_FILE):
        try:
            with open(PROMPT_FILE, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception as e:
            print(f"Error reading prompt file {PROMPT_FILE}: {e}")
    return DEFAULT_PROMPT

class OpenAIService:
    def __init__(self):
        # AsyncOpenAI will automatically use settings.OPENAI_API_KEY or os.environ.get("OPENAI_API_KEY")
        api_key = settings.OPENAI_API_KEY or os.environ.get("OPENAI_API_KEY", "") or "mock-key-value"
        self.client = AsyncOpenAI(api_key=api_key)

    async def get_embedding(self, text: str) -> List[float]:
        """
        Generates text embedding using text-embedding-3-small.
        """
        try:
            response = await self.client.embeddings.create(
                input=[text],
                model="text-embedding-3-small"
            )
            return response.data[0].embedding
        except Exception as e:
            print(f"Error generating embedding: {e}")
            raise

    async def transcribe_audio(self, file_path: str) -> str:
        """
        Transcribes audio using Whisper API.
        """
        try:
            if not os.path.exists(file_path):
                raise FileNotFoundError(f"Audio file not found: {file_path}")
            
            with open(file_path, "rb") as audio_file:
                transcription = await self.client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file
                )
            return transcription.text
        except Exception as e:
            print(f"Error transcribing audio {file_path}: {e}")
            return f"[Ошибка транскрипции аудио: {str(e)}]"

    async def describe_image(self, file_path: str) -> str:
        """
        Analyzes an image using GPT-4o-mini Vision.
        """
        try:
            if not os.path.exists(file_path):
                raise FileNotFoundError(f"Image file not found: {file_path}")
                
            # Get file extension / mime type
            ext = os.path.splitext(file_path)[1].lower().replace('.', '')
            mime_type = f"image/{ext}"
            if ext == 'jpg':
                mime_type = "image/jpeg"

            with open(file_path, "rb") as image_file:
                base64_image = base64.b64encode(image_file.read()).decode('utf-8')

            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Опиши подробно, что изображено на картинке. Если это скриншот ошибки, выпиши текст ошибки."},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{mime_type};base64,{base64_image}"
                                }
                            }
                        ]
                    }
                ],
                max_tokens=300
            )
            return response.choices[0].message.content or ""
        except Exception as e:
            print(f"Error describing image {file_path}: {e}")
            return f"[Ошибка анализа изображения: {str(e)}]"

    async def generate_answer(
        self, 
        query: str, 
        history: List[Dict[str, str]], 
        kb_chunks: List[str]
    ) -> Tuple[str, float, int]:
        """
        Generates structured answer from GPT based on user query, history, and retrieved knowledge base chunks.
        Returns: (response_text, confidence, tokens_used)
        """
        system_prompt = get_system_prompt()

        context_str = "\n---\n".join([f"Документ:\n{chunk}" for chunk in kb_chunks])
        
        messages = [
            {"role": "system", "content": system_prompt},
        ]
        
        # Add history
        for msg in history:
            messages.append({"role": msg["role"], "content": msg["content"]})
            
        # Add context and query
        user_message_content = (
            f"База Знаний:\n{context_str}\n\n"
            f"Текущий вопрос пользователя: {query}"
        )
        messages.append({"role": "user", "content": user_message_content})

        try:
            start_time = time.time()
            response = await self.client.beta.chat.completions.parse(
                model="gpt-4o-mini",
                messages=messages,
                response_format=AIResponse,
                temperature=0.0
            )
            parsed = response.choices[0].message.parsed
            tokens_used = response.usage.total_tokens if response.usage else 0
            
            if not parsed:
                raise ValueError("Не удалось распарсить структурированный ответ от OpenAI.")
                
            return parsed.response_text, parsed.confidence, tokens_used
            
        except Exception as e:
            print(f"Error in OpenAI chat completion: {e}")
            raise e

# Instantiate a global service instance
openai_service = OpenAIService()
