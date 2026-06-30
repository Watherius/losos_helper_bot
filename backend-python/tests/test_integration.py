import os
import sys
import json
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

class TestWhatsAppAIBot(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Patch Redis and database sessions
        self.redis_patch = patch('app.services.buffer.redis_client', new_callable=AsyncMock)
        self.mock_redis = self.redis_patch.start()
        
        self.queue_redis_patch = patch('app.services.queue.redis_client', new_callable=AsyncMock)
        self.mock_queue_redis = self.queue_redis_patch.start()

        # Import main app after patching
        from app.main import app
        self.client = TestClient(app)

    def tearDown(self):
        self.redis_patch.stop()
        self.queue_redis_patch.stop()

    def test_health_check(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "healthy"})

    @patch('app.main.add_to_buffer', new_callable=AsyncMock)
    def test_webhook_endpoint(self, mock_add_to_buffer):
        payload = {
            "chat_id": "12345@g.us",
            "chat_name": "Test Group",
            "sender_id": "98765@s.whatsapp.net",
            "sender_name": "John Doe",
            "sender_phone": "98765",
            "message_id": "MSG123",
            "timestamp": "2026-06-30T19:46:12Z",
            "type": "text",
            "text": "Hello World"
        }
        
        response = self.client.post("/webhook", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "success", "message": "Message buffered"})
        
        # Verify that add_to_buffer was called with correct arguments
        mock_add_to_buffer.assert_called_once_with("12345@g.us", "98765@s.whatsapp.net", payload)

    @patch('app.services.buffer.run_debouncer', new_callable=AsyncMock)
    async def test_buffer_adding_and_timer_trigger(self, mock_run_debouncer):
        from app.services.buffer import add_to_buffer
        
        # Mock Redis get to return None (indicating no active timer)
        self.mock_redis.get.return_value = None
        
        payload = {"text": "Test"}
        await add_to_buffer("chat123", "user456", payload)
        
        # Verify message pushed to Redis buffer list
        self.mock_redis.rpush.assert_called_once()
        args = self.mock_redis.rpush.call_args[0]
        self.assertEqual(args[0], "buffer:chat123:user456")
        self.assertIn('"text": "Test"', args[1])
        
        # Verify last time updated
        self.mock_redis.set.assert_any_call("last_time:chat123:user456", unittest.mock.ANY)
        
        # Verify debouncer scheduled
        self.mock_redis.set.assert_any_call("task_active:chat123:user456", "true")

    @patch('app.services.queue.process_user_queue', new_callable=AsyncMock)
    async def test_queue_locking_and_execution(self, mock_process_user_queue):
        from app.services.queue import enqueue_buffer_for_processing
        
        # Mock Redis lpop to return buffer messages, then None
        self.mock_queue_redis.lpop.side_effect = [
            json.dumps({"text": "Message 1"}),
            json.dumps({"text": "Message 2"}),
            None
        ]
        
        # Mock lock acquisition to be successful
        self.mock_queue_redis.set.return_value = True
        
        await enqueue_buffer_for_processing("chat123", "user456")
        
        # Verify items pushed to user queue
        self.mock_queue_redis.rpush.assert_called_once()
        q_args = self.mock_queue_redis.rpush.call_args[0]
        self.assertEqual(q_args[0], "queue:chat123:user456")
        self.assertIn("Message 1", q_args[1])
        self.assertIn("Message 2", q_args[1])
        
        # Verify lock requested
        self.mock_queue_redis.set.assert_called_with("lock:chat123:user456", "locked", nx=True, ex=300)

if __name__ == "__main__":
    unittest.main()
