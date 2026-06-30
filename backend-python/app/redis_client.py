import redis.asyncio as aioredis
from app.config import settings

redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)

def init_redis():
    return redis_client

async def close_redis():
    if redis_client:
        await redis_client.close()
