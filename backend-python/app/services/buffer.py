import json
import time
import asyncio
from app.redis_client import redis_client
from app.config import settings
from app.services.queue import enqueue_buffer_for_processing

async def add_to_buffer(chat_id: str, sender_id: str, message_data: dict):
    """
    Adds a message to the user's buffer in Redis and schedules/resets the debouncing timer.
    """
    buffer_key = f"buffer:{chat_id}:{sender_id}"
    last_time_key = f"last_time:{chat_id}:{sender_id}"
    task_active_key = f"task_active:{chat_id}:{sender_id}"

    # Push message to buffer list
    await redis_client.rpush(buffer_key, json.dumps(message_data))
    # Update last message time (for debouncing)
    await redis_client.set(last_time_key, time.time())

    # If timeout is 0 or less, process immediately bypassing the debounce timer
    if settings.BUFFER_TIMEOUT_SECONDS <= 0:
        await enqueue_buffer_for_processing(chat_id, sender_id)
        return

    # Check if a timer task is already active for this user
    is_active = await redis_client.get(task_active_key)
    if not is_active:
        await redis_client.set(task_active_key, "true")
        # Run the debouncing loop in the background
        asyncio.create_task(run_debouncer(chat_id, sender_id))

async def run_debouncer(chat_id: str, sender_id: str):
    """
    Background loop that waits until there has been 5 seconds of silence from the user.
    """
    last_time_key = f"last_time:{chat_id}:{sender_id}"
    task_active_key = f"task_active:{chat_id}:{sender_id}"
    
    try:
        while True:
            last_time_str = await redis_client.get(last_time_key)
            if not last_time_str:
                break
            
            last_time = float(last_time_str)
            now = time.time()
            elapsed = now - last_time
            
            # If 5 seconds have passed since the last message, stop waiting
            if elapsed >= settings.BUFFER_TIMEOUT_SECONDS:
                break
            
            # Otherwise sleep the remaining time
            sleep_time = settings.BUFFER_TIMEOUT_SECONDS - elapsed
            await asyncio.sleep(sleep_time)
            
        # Clean up task active status
        await redis_client.delete(task_active_key)
        
        # Enqueue buffer for sequential processing
        await enqueue_buffer_for_processing(chat_id, sender_id)
        
    except Exception as e:
        print(f"Error in debouncer for {chat_id}:{sender_id}: {e}")
        await redis_client.delete(task_active_key)
