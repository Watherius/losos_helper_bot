import json
import asyncio
from app.redis_client import redis_client

async def enqueue_buffer_for_processing(chat_id: str, sender_id: str):
    """
    Pulls all messages from the user's buffer, combines them,
    and pushes them to the user's sequential processing queue.
    """
    buffer_key = f"buffer:{chat_id}:{sender_id}"
    queue_key = f"queue:{chat_id}:{sender_id}"
    lock_key = f"lock:{chat_id}:{sender_id}"
    
    messages = []
    while True:
        msg_str = await redis_client.lpop(buffer_key)
        if not msg_str:
            break
        messages.append(json.loads(msg_str))
        
    if not messages:
        return
        
    # Push combined messages to the user queue
    await redis_client.rpush(queue_key, json.dumps(messages))
    
    # Try to acquire lock for 5 minutes (300 seconds)
    acquired = await redis_client.set(lock_key, "locked", nx=True, ex=300)
    if acquired:
        # Start a sequential worker for this user
        asyncio.create_task(process_user_queue(chat_id, sender_id))

async def process_user_queue(chat_id: str, sender_id: str):
    """
    Sequentially processes all combined message batches for a specific user.
    """
    queue_key = f"queue:{chat_id}:{sender_id}"
    lock_key = f"lock:{chat_id}:{sender_id}"
    
    # Lazy import to avoid circular dependencies
    from app.services.processor import process_message_job
    
    try:
        while True:
            # Pop next batch of messages
            batch_str = await redis_client.lpop(queue_key)
            if not batch_str:
                break
                
            messages_batch = json.loads(batch_str)
            try:
                await process_message_job(chat_id, sender_id, messages_batch)
            except Exception as e:
                print(f"Error processing job for {chat_id}:{sender_id}: {e}")
                
    finally:
        # Release the lock
        await redis_client.delete(lock_key)
        
        # Check if new items arrived right after we broke out but before deleting the lock
        queue_len = await redis_client.llen(queue_key)
        if queue_len > 0:
            acquired = await redis_client.set(lock_key, "locked", nx=True, ex=300)
            if acquired:
                asyncio.create_task(process_user_queue(chat_id, sender_id))
