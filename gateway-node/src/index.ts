import fastify from 'fastify';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  proto,
  WASocket,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
// @ts-ignore
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000/webhook';

const server = fastify({ logger: true });
let sock: WASocket | null = null;
const groupCache = new Map<string, string>();

// Connection State Variables for Web UI
let connectionStatus = 'connecting'; // connecting, qr, connected, error
let qrCodeDataUrl = '';
let activeUser = { name: '', id: '' };
let connectionDate = '';

// Memory buffer for logs displayed in Web UI
const appLogs: string[] = [];
function addLog(msg: string) {
  const time = new Date().toLocaleTimeString('ru-RU');
  appLogs.push(`[${time}] ${msg}`);
  if (appLogs.length > 100) {
    appLogs.shift();
  }
}

// Helper to extract nested messages (viewOnce, ephemeral, etc.)
function getMessageContent(message: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
  if (!message) return null;
  if (message.viewOnceMessage?.message) return getMessageContent(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return getMessageContent(message.viewOnceMessageV2.message);
  if (message.ephemeralMessage?.message) return getMessageContent(message.ephemeralMessage.message);
  if (message.editedMessage?.message) return getMessageContent(message.editedMessage.message);
  if (message.documentWithCaptionMessage?.message) return getMessageContent(message.documentWithCaptionMessage.message);
  return message;
}

// Helper to download media message
async function downloadMedia(messageContent: any, type: 'image' | 'video' | 'audio' | 'document', filename: string): Promise<string> {
  const stream = await downloadContentFromMessage(messageContent, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  
  const dir = '/app/shared_media';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const filepath = path.join(dir, filename);
  await fs.promises.writeFile(filepath, buffer);
  return filepath;
}

// Fetch group subject with caching
async function getChatName(chatId: string): Promise<string> {
  if (!chatId.endsWith('@g.us')) {
    return 'Личный чат';
  }
  if (groupCache.has(chatId)) {
    return groupCache.get(chatId)!;
  }
  if (sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      if (metadata && metadata.subject) {
        groupCache.set(chatId, metadata.subject);
        return metadata.subject;
      }
    } catch (err) {
      server.log.error(err as Error, `Ошибка получения метаданных группы ${chatId}`);
    }
  }
  return 'Групповой чат';
}

// Resolve LID JID to phone JID using group metadata participants
async function resolveLidToPhoneJid(chatId: string, lidJid: string): Promise<string> {
  if (!chatId.endsWith('@g.us') || !lidJid.endsWith('@lid')) {
    return lidJid;
  }
  if (sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      if (metadata && metadata.participants) {
        const cleanLid = lidJid.split(':')[0];
        const participant = metadata.participants.find(p => p.lid && p.lid.split(':')[0] === cleanLid);
        if (participant && participant.id) {
          return participant.id;
        }
      }
    } catch (err) {
      server.log.error(err as Error, `Ошибка разрешения LID ${lidJid} в группе ${chatId}`);
    }
  }
  return lidJid;
}

// Connect to WhatsApp
async function connectToWhatsApp() {
  addLog('Инициализация сессии Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  const { version, isLatest } = await fetchLatestBaileysVersion();
  addLog(`Версия WhatsApp: v${version.join('.')}, актуальная: ${isLatest}`);
  
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false, // Prevents loading massive past chats to avoid timeouts
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 60000,
    markOnlineOnConnect: true
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      connectionStatus = 'qr';
      try {
        qrCodeDataUrl = await QRCode.toDataURL(qr);
        addLog('Сгенерирован новый QR-код для авторизации. Отсканируйте его в браузере.');
      } catch (err) {
        addLog('Ошибка генерации картинки QR-кода.');
      }
      qrcodeTerminal.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      const errMsg = lastDisconnect?.error?.message || 'причина не указана';
      addLog(`Соединение закрыто (${errMsg}). Попытка переподключения: ${shouldReconnect}`);
      
      if (!shouldReconnect) {
        connectionStatus = 'qr';
        activeUser = { name: '', id: '' };
        qrCodeDataUrl = '';
        connectionDate = '';
      } else {
        connectionStatus = 'connecting';
      }
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      connectionDate = new Date().toLocaleString('ru-RU');
      if (sock && sock.user) {
        activeUser = {
          name: sock.user.name || 'Поддержка Лосось',
          id: sock.user.id
        };
        const botLid = (sock.user as any).lid || 'нет';
        qrCodeDataUrl = '';
        addLog(`Успешный вход! Бот подключен как: ${activeUser.name} (JID: ${activeUser.id.split('@')[0].split(':')[0]}, LID: ${botLid})`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      
      const chatId = msg.key.remoteJid || '';
      const senderId = msg.key.participant || msg.key.remoteJid || '';
      
      // Resolve LID to phone JID for better phone extraction and logging
      let resolvedSenderId = senderId;
      if (senderId.endsWith('@lid')) {
        resolvedSenderId = await resolveLidToPhoneJid(chatId, senderId);
      }
      const senderPhone = resolvedSenderId.split('@')[0].split(':')[0];
      const senderName = msg.pushName || 'Неизвестный';
      const messageId = msg.key.id || '';
      const timestamp = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString();
      const chatName = await getChatName(chatId);
      
      const content = getMessageContent(msg.message);
      if (!content) continue;

      const contextInfo = content.extendedTextMessage?.contextInfo ||
                          content.imageMessage?.contextInfo ||
                          content.videoMessage?.contextInfo ||
                          content.audioMessage?.contextInfo ||
                          content.documentMessage?.contextInfo;

      let payload: any = {
        chat_id: chatId,
        chat_name: chatName,
        sender_id: senderId,
        sender_name: senderName,
        sender_phone: senderPhone,
        message_id: messageId,
        timestamp: timestamp,
        reply_to: contextInfo?.stanzaId || null,
        type: 'text',
        text: ''
      };

      try {
        if (content.conversation) {
          payload.type = 'text';
          payload.text = content.conversation;
        } else if (content.extendedTextMessage) {
          payload.type = 'text';
          payload.text = content.extendedTextMessage.text || '';
        } else if (content.imageMessage) {
          const extension = content.imageMessage.mimetype?.split('/')[1] || 'jpeg';
          const filename = `${messageId}.${extension}`;
          const filepath = await downloadMedia(content.imageMessage, 'image', filename);
          
          payload.type = 'image';
          payload.file_path = filepath;
          payload.caption = content.imageMessage.caption || '';
        } else if (content.audioMessage) {
          const extension = content.audioMessage.mimetype?.split(';')[0]?.split('/')[1] || 'ogg';
          const filename = `${messageId}.${extension}`;
          const filepath = await downloadMedia(content.audioMessage, 'audio', filename);
          
          payload.type = 'audio';
          payload.file_path = filepath;
        } else if (content.videoMessage) {
          const extension = content.videoMessage.mimetype?.split('/')[1] || 'mp4';
          const filename = `${messageId}.${extension}`;
          const filepath = await downloadMedia(content.videoMessage, 'video', filename);
          
          payload.type = 'video';
          payload.file_path = filepath;
          payload.caption = content.videoMessage.caption || '';
        } else if (content.documentMessage) {
          const filename = content.documentMessage.fileName || `${messageId}.bin`;
          const filepath = await downloadMedia(content.documentMessage, 'document', filename);
          
          payload.type = 'document';
          payload.file_path = filepath;
          payload.caption = content.documentMessage.caption || '';
        } else if (content.reactionMessage) {
          payload.type = 'reaction';
          payload.text = content.reactionMessage.text || '';
          payload.reply_to = content.reactionMessage.key?.id || null;
        } else {
          payload.type = 'unknown';
          payload.text = '[Неподдерживаемый тип сообщения]';
        }

        const isGroup = chatId.endsWith('@g.us');
        addLog(`Входящее сообщение в "${chatName}" от ${senderName}: "${payload.text || '[медиа/реакция]'}"`);

        // Group filtering: only answer if mentioned or replied to
        if (isGroup && sock?.user) {
          const botJid = sock.user.id.replace(/:.+@/, '@'); // Clean JID without device ID
          const botPhone = sock.user.id.split('@')[0].split(':')[0];
          
          const botLid = (sock.user as any).lid ? (sock.user as any).lid.replace(/:.+@/, '@') : null;
          const botLidPhone = botLid ? botLid.split('@')[0].split(':')[0] : null;

          const mentionedJids = contextInfo?.mentionedJid || [];
          const msgText = payload.text || payload.caption || '';
          
          const isMentioned = mentionedJids.includes(botJid) || 
                              (botLid && mentionedJids.includes(botLid)) ||
                              msgText.includes('@' + botPhone) ||
                              (botLidPhone && msgText.includes('@' + botLidPhone)) ||
                              (sock.user.name && msgText.toLowerCase().includes(sock.user.name.toLowerCase()));
                              
          const isReplyToMe = (contextInfo?.participant?.split(':')[0] === sock.user.id.split(':')[0]) ||
                              (botLid && contextInfo?.participant?.split(':')[0] === botLid.split(':')[0]);
          
          if (!isMentioned && !isReplyToMe) {
            addLog(`[Группа] Сообщение от ${senderName} пропущено (нет упоминания @${botPhone}${botLidPhone ? ' или @' + botLidPhone : ''})`);
            continue;
          } else {
            addLog(`[Группа] Сообщение адресовано боту (упоминание: ${isMentioned}, ответ: ${isReplyToMe}).`);
          }
        }

        addLog(`Пересылка сообщения на бэкенд Python (webhook)...`);
        
        // Show composing (typing) status
        if (sock) {
          await sock.sendPresenceUpdate('composing', chatId);
        }
        
        await axios.post(BACKEND_URL, payload);
      } catch (err: any) {
        addLog(`[Ошибка] Не удалось обработать сообщение: ${err.message}`);
      }
    }
  });
}

// REST Endpoints
server.get('/status', async (request, reply) => {
  return {
    status: connectionStatus,
    qr: qrCodeDataUrl,
    user: activeUser,
    connectionDate: connectionDate
  };
});

server.get('/api/logs', async (request, reply) => {
  return {
    logs: appLogs
  };
});

server.post('/disconnect', async (request, reply) => {
  addLog('Запрос на отвязку устройства WhatsApp и сброс сессии...');
  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      addLog('Не удалось выполнить деавторизацию сессии (уже отключен).');
    }
  }

  // Delete credentials folder
  const sessionDir = 'auth_info_baileys';
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      addLog('Сессионные файлы Baileys стерты.');
    } catch (err) {
      addLog('Ошибка удаления папки авторизации.');
    }
  }

  connectionStatus = 'qr';
  qrCodeDataUrl = '';
  activeUser = { name: '', id: '' };
  connectionDate = '';

  // Restart Baileys to obtain a new QR code immediately
  connectToWhatsApp();

  return { success: true };
});

server.post<{ Body: { chat_id: string; text: string; reply_to?: string; mention_jid?: string } }>('/send', async (request, reply) => {
  const { chat_id, text, reply_to, mention_jid } = request.body;
  if (!sock) {
    addLog('[Ошибка] Не могу отправить ответ: клиент WhatsApp не подключен.');
    return reply.status(500).send({ error: 'Клиент WhatsApp не подключен' });
  }
  
  try {
    // Stop typing indicator
    await sock.sendPresenceUpdate('paused', chat_id);

    const options: any = {};
    let responseText = text;

    // Resolve mention LID to phone JID before formatting the mention
    let resolvedMentionJid = mention_jid;
    if (mention_jid && mention_jid.endsWith('@lid')) {
      resolvedMentionJid = await resolveLidToPhoneJid(chat_id, mention_jid);
    }

    if (reply_to) {
      options.quoted = {
        key: {
          remoteJid: chat_id,
          id: reply_to,
          fromMe: false,
          participant: chat_id.endsWith('@g.us') ? resolvedMentionJid : undefined
        },
        message: {
          conversation: ''
        }
      };
    }

    // Add mention JID to options without altering the response text
    if (resolvedMentionJid && chat_id.endsWith('@g.us')) {
      options.mentions = [resolvedMentionJid];
    }
    
    addLog(`Отправка сообщения в ${chat_id}: "${responseText.substring(0, 60)}..."`);
    await sock.sendMessage(chat_id, { text: responseText }, options);
    return { success: true };
  } catch (err: any) {
    addLog(`[Ошибка отправки сообщения] ${err.message}`);
    return reply.status(500).send({ error: 'Не удалось отправить сообщение: ' + err.message });
  }
});

// HTML Dashboard UI
server.get('/', async (request, reply) => {
  reply.type('text/html');
  return `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp AI Ассистент — Панель управления</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: rgba(17, 24, 39, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-color: #f3f4f6;
            --text-muted: #9ca3af;
            --primary: #6366f1;
            --primary-glow: rgba(99, 102, 241, 0.35);
            --success: #10b981;
            --success-glow: rgba(16, 185, 129, 0.25);
            --error: #ef4444;
            --error-glow: rgba(239, 68, 68, 0.2);
            --warning: #f59e0b;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.1) 0%, transparent 40%);
        }

        header {
            padding: 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            background: rgba(11, 15, 25, 0.5);
            backdrop-filter: blur(10px);
        }

        .logo {
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .logo-dot {
            width: 8px;
            height: 8px;
            background-color: var(--success);
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 10px var(--success);
        }

        main {
            max-width: 1200px;
            width: 100%;
            margin: 3rem auto;
            padding: 0 2rem;
            display: grid;
            grid-template-columns: 1fr 1.2fr;
            gap: 2.5rem;
            flex-grow: 1;
        }

        @media (max-width: 900px) {
            main {
                grid-template-columns: 1fr;
            }
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 20px;
            padding: 2.5rem;
            backdrop-filter: blur(16px);
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            transition: transform 0.3s ease, border-color 0.3s ease;
        }

        .card:hover {
            border-color: rgba(99, 102, 241, 0.2);
        }

        textarea:focus {
            border-color: var(--primary) !important;
            box-shadow: 0 0 10px var(--primary-glow);
        }

        .card-title {
            font-size: 1.25rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .card-description {
            font-size: 0.9rem;
            color: var(--text-muted);
            line-height: 1.5;
        }

        /* Connection Status Widget */
        .status-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 280px;
            border-radius: 15px;
            background: rgba(255,255,255,0.02);
            border: 1px dashed rgba(255,255,255,0.05);
            padding: 2rem;
            position: relative;
        }

        .status-badge {
            position: absolute;
            top: 1rem;
            right: 1rem;
            font-size: 0.8rem;
            font-weight: 600;
            padding: 0.35rem 0.75rem;
            border-radius: 50px;
            text-transform: uppercase;
        }

        .status-badge.connecting {
            background-color: rgba(245, 158, 11, 0.1);
            color: var(--warning);
            border: 1px solid rgba(245, 158, 11, 0.2);
        }

        .status-badge.qr {
            background-color: rgba(99, 102, 241, 0.1);
            color: var(--primary);
            border: 1px solid rgba(99, 102, 241, 0.2);
        }

        .status-badge.connected {
            background-color: rgba(16, 185, 129, 0.1);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.2);
            box-shadow: 0 0 15px rgba(16, 185, 129, 0.1);
        }

        .qr-code-wrapper {
            background: white;
            padding: 1rem;
            border-radius: 12px;
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
            display: none;
            transition: all 0.3s ease;
        }

        .qr-code-wrapper img {
            display: block;
            width: 200px;
            height: 200px;
        }

        .success-illustration {
            display: none;
            flex-direction: column;
            align-items: center;
            gap: 1rem;
            text-align: center;
            width: 100%;
        }

        .success-circle {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: rgba(16, 185, 129, 0.1);
            border: 2px solid var(--success);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--success);
            font-size: 2.5rem;
            box-shadow: 0 0 20px var(--success-glow);
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(1); box-shadow: 0 0 20px var(--success-glow); }
            50% { transform: scale(1.05); box-shadow: 0 0 30px rgba(16, 185, 129, 0.4); }
            100% { transform: scale(1); box-shadow: 0 0 20px var(--success-glow); }
        }

        .spinner {
            width: 50px;
            height: 50px;
            border: 3px solid rgba(255,255,255,0.05);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .user-details {
            margin-top: 0.5rem;
            font-size: 0.95rem;
            color: var(--text-muted);
            line-height: 1.6;
        }

        .user-name {
            font-weight: 600;
            color: var(--text-color);
        }

        .disconnect-btn {
            background: transparent;
            color: var(--error);
            border: 1px solid var(--error);
            padding: 0.5rem 1rem;
            border-radius: 8px;
            font-weight: 600;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-top: 1rem;
        }

        .disconnect-btn:hover {
            background: var(--error);
            color: white;
            box-shadow: 0 0 15px var(--error-glow);
        }

        /* Upload Area */
        .upload-area {
            border: 2px dashed rgba(255,255,255,0.1);
            border-radius: 15px;
            padding: 2.5rem;
            text-align: center;
            background: rgba(255,255,255,0.01);
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1rem;
        }

        .upload-area:hover, .upload-area.dragover {
            border-color: var(--primary);
            background: rgba(99, 102, 241, 0.05);
            box-shadow: 0 0 20px var(--primary-glow);
        }

        .upload-icon {
            font-size: 2.5rem;
            color: var(--primary);
        }

        .upload-btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 0.6rem 1.2rem;
            border-radius: 8px;
            font-weight: 600;
            font-size: 0.9rem;
            cursor: pointer;
            transition: background 0.2s;
            margin-top: 0.5rem;
        }

        .upload-btn:hover {
            background: #4f46e5;
        }

        #file-input {
            display: none;
        }

        /* Files list */
        .files-section-title {
            font-weight: 600;
            font-size: 1rem;
            margin-top: 1rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 0.5rem;
        }

        .files-list {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            max-height: 250px;
            overflow-y: auto;
            padding-right: 0.5rem;
        }

        .file-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 1rem;
            border-radius: 10px;
            background: rgba(255,255,255,0.02);
            border: 1px solid var(--border-color);
        }

        .file-info {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.9rem;
        }

        .file-icon {
            font-size: 1.1rem;
        }

        .file-name {
            font-weight: 500;
            max-width: 320px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .delete-btn {
            background: transparent;
            color: var(--text-muted);
            border: none;
            font-size: 1.2rem;
            cursor: pointer;
            padding: 0.2rem 0.5rem;
            border-radius: 6px;
            transition: all 0.2s ease;
        }

        .delete-btn:hover {
            color: var(--error);
            background: rgba(239, 68, 68, 0.1);
        }

        .no-files {
            text-align: center;
            color: var(--text-muted);
            font-size: 0.85rem;
            padding: 1.5rem 0;
            font-style: italic;
        }

        /* Toaster */
        .toast-container {
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            z-index: 1000;
        }

        .toast {
            background: rgba(17, 24, 39, 0.95);
            border: 1px solid var(--border-color);
            padding: 1rem 1.5rem;
            border-radius: 10px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            color: var(--text-color);
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 0.9rem;
            backdrop-filter: blur(10px);
            transform: translateY(100px);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        .toast.show {
            transform: translateY(0);
            opacity: 1;
        }

        .toast.success { border-left: 4px solid var(--success); }
        .toast.error { border-left: 4px solid var(--error); }

        footer {
            text-align: center;
            padding: 2rem;
            font-size: 0.85rem;
            color: var(--text-muted);
            border-top: 1px solid var(--border-color);
            background: rgba(11, 15, 25, 0.5);
        }
    </style>
</head>
<body>

    <header>
        <div class="logo">
            <span class="logo-dot"></span>
            WhatsApp AI Ассистент
        </div>
    </header>

    <main>
        <!-- Левая колонка: Подключение и Настройки -->
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            <div class="card">
                <div class="card-title">
                    🌐 Статус подключения
                </div>
                <p class="card-description">
                    Здесь отображается текущее состояние соединения с WhatsApp. Если вы запускаете бота впервые, отсканируйте QR-код ниже через приложение WhatsApp.
                </p>
                <div class="status-container" id="status-box">
                    <div class="status-badge connecting" id="status-badge">Подключение...</div>
                    
                    <!-- Спиннер загрузки -->
                    <div class="spinner" id="spinner"></div>

                    <!-- QR код -->
                    <div class="qr-code-wrapper" id="qr-wrapper">
                        <img id="qr-image" src="" alt="QR Code для авторизации">
                    </div>

                    <!-- Успешное подключение -->
                    <div class="success-illustration" id="success-box">
                        <div class="success-circle">✓</div>
                        <h3>Соединение установлено!</h3>
                        <div class="user-details" id="user-details">
                            Бот: <span class="user-name" id="user-name">Неизвестно</span><br>
                            Номер: <span id="user-phone">Неизвестно</span><br>
                            Дата соединения: <span id="connection-date">Неизвестно</span>
                        </div>
                        <button class="disconnect-btn" onclick="disconnectDevice()">Отвязать устройство</button>
                    </div>
                </div>
            </div>

            <!-- Блок изменения поведения ИИ -->
            <div class="card">
                <div class="card-title">
                    🧠 Настройка поведения ИИ
                </div>
                <p class="card-description">
                    Здесь вы можете изменить системный промпт (инструкцию ИИ), чтобы настроить тон ответов, правила форматирования или ограничения.
                </p>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    <textarea id="prompt-input" rows="8" style="width: 100%; background: #05070c; color: var(--text-color); border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; font-family: sans-serif; font-size: 0.9rem; line-height: 1.5; resize: vertical; outline: none; transition: border-color 0.2s;" placeholder="Введите системную инструкцию для ИИ..."></textarea>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <button class="upload-btn" onclick="savePrompt()" style="margin-top: 0; background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);" id="save-prompt-btn">Сохранить промпт</button>
                        <button onclick="resetPromptToDefault()" style="background: transparent; color: var(--text-muted); border: 1px solid var(--border-color); padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease;">Сбросить</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Правая колонка: База знаний (RAG) -->
        <div class="card">
            <div class="card-title">
                📚 База знаний (RAG)
            </div>
            <p class="card-description">
                Загрузите инструкции, регламенты или файлы ответов (поддерживаются PDF, DOCX, XLSX, TXT, MD). ИИ будет использовать их как единственный источник правды.
            </p>
            <div class="upload-area" id="drop-zone">
                <div class="upload-icon">📥</div>
                <h3>Перетащите файл сюда</h3>
                <p style="font-size: 0.85rem; color: var(--text-muted)">или выберите на компьютере</p>
                <input type="file" id="file-input" accept=".pdf,.docx,.xlsx,.txt,.md">
                <button class="upload-btn" onclick="document.getElementById('file-input').click()">Выбрать файл</button>
            </div>

            <div class="files-section-title">Загруженные файлы базы знаний:</div>
            <div class="files-list" id="files-list">
                <div class="no-files">Загрузка файлов...</div>
            </div>
        </div>

        <!-- Нижняя колонка во всю ширину: Логи системы -->
        <div class="card" style="grid-column: 1 / -1; margin-top: 0.5rem; position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="card-title">
                    📋 Логи системы (События в реальном времени)
                </div>
                <button onclick="copyLogs()" style="background: rgba(255,255,255,0.05); color: var(--text-color); border: 1px solid var(--border-color); padding: 0.4rem 0.8rem; border-radius: 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease;" id="copy-btn">Копировать логи</button>
            </div>
            <p class="card-description">
                Здесь в реальном времени выводятся все действия бота, ошибки связи и пересылка сообщений.
            </p>
            <div id="logs-box" style="background: #05070c; font-family: monospace; color: #10b981; padding: 1.5rem; border-radius: 12px; height: 250px; overflow-y: auto; font-size: 0.85rem; line-height: 1.5; border: 1px solid var(--border-color); white-space: pre-wrap;">
                Загрузка системных логов...
            </div>
        </div>
    </main>

    <footer>
        Разработано с использованием Baileys, FastAPI и OpenAI
    </footer>

    <div class="toast-container" id="toast-container"></div>

    <script>
        // Статусы
        const statusBadge = document.getElementById('status-badge');
        const spinner = document.getElementById('spinner');
        const qrWrapper = document.getElementById('qr-wrapper');
        const qrImage = document.getElementById('qr-image');
        const successBox = document.getElementById('success-box');
        const userName = document.getElementById('user-name');
        const userPhone = document.getElementById('user-phone');
        const connectionDate = document.getElementById('connection-date');
        const filesList = document.getElementById('files-list');
        const logsBox = document.getElementById('logs-box');

        // Опросы статуса раз в 3 секунды
        async function checkStatus() {
            try {
                const response = await fetch('/status');
                const data = await response.json();
                
                // Сброс видимости
                spinner.style.display = 'none';
                qrWrapper.style.display = 'none';
                successBox.style.display = 'none';

                statusBadge.className = 'status-badge ' + data.status;

                if (data.status === 'connecting') {
                    statusBadge.innerText = 'Подключение...';
                    spinner.style.display = 'block';
                } else if (data.status === 'qr') {
                    statusBadge.innerText = 'Ожидает авторизации';
                    if (data.qr) {
                        qrImage.src = data.qr;
                        qrWrapper.style.display = 'block';
                    } else {
                        spinner.style.display = 'block';
                    }
                } else if (data.status === 'connected') {
                    statusBadge.innerText = 'В сети';
                    successBox.style.display = 'flex';
                    userName.innerText = data.user.name || 'Поддержка';
                    userPhone.innerText = '+' + data.user.id.split('@')[0].split(':')[0];
                    connectionDate.innerText = data.connectionDate || 'Неизвестно';
                } else {
                    statusBadge.innerText = 'Ошибка';
                    spinner.style.display = 'block';
                }
            } catch (err) {
                console.error('Ошибка получения статуса:', err);
            }
        }

        // Загрузка и вывод логов
        async function loadLogs() {
            try {
                const response = await fetch('/api/logs');
                const data = await response.json();
                if (data && data.logs) {
                    const isAtBottom = logsBox.scrollHeight - logsBox.scrollTop === logsBox.clientHeight;
                    
                    if (data.logs.length === 0) {
                        logsBox.innerHTML = '<div style="color: var(--text-muted)">Ожидание событий... Отправьте сообщение боту.</div>';
                    } else {
                        logsBox.innerText = data.logs.join('\\n');
                    }
                    
                    // Автоскролл к новым строчкам, если пользователь сам не скроллил наверх
                    if (isAtBottom || logsBox.innerHTML.includes('Загрузка системных логов...')) {
                        logsBox.scrollTop = logsBox.scrollHeight;
                    }
                }
            } catch (err) {
                console.error('Ошибка загрузки логов:', err);
            }
        }

        // Отвязать устройство
        async function disconnectDevice() {
            if (!confirm('Вы уверены, что хотите отвязать это устройство? Бот перестанет отвечать в чатах.')) {
                return;
            }
            showToast('Отвязка устройства...', 'success');
            try {
                const response = await fetch('/disconnect', { method: 'POST' });
                if (response.ok) {
                    showToast('Устройство успешно отвязано. Сессия сброшена.', 'success');
                    checkStatus();
                } else {
                    showToast('Не удалось отвязать устройство.', 'error');
                }
            } catch (err) {
                showToast('Ошибка при отправке запроса на отключение.', 'error');
            }
        }

        // Загрузка списка файлов
        async function loadFiles() {
            try {
                const response = await fetch('http://localhost:8000/admin/kb-files');
                if (!response.ok) {
                    throw new Error('Failed to fetch files');
                }
                const data = await response.json();
                renderFiles(data.files);
            } catch (err) {
                console.error('Ошибка загрузки файлов RAG:', err);
                filesList.innerHTML = '<div class="no-files" style="color: var(--error)">Не удалось загрузить файлы из бэкенда.</div>';
            }
        }

        function renderFiles(files) {
            filesList.innerHTML = '';
            if (!files || files.length === 0) {
                filesList.innerHTML = '<div class="no-files">Нет загруженных файлов. База знаний пуста.</div>';
                return;
            }

            files.forEach(filename => {
                const item = document.createElement('div');
                item.className = 'file-item';
                
                let icon = '📄';
                const ext = filename.split('.').pop().toLowerCase();
                if (ext === 'pdf') icon = '📕';
                else if (ext === 'docx') icon = '📘';
                else if (ext === 'xlsx') icon = '📗';
                else if (ext === 'md') icon = '📝';

                item.innerHTML = \`
                    <div class="file-info">
                        <span class="file-icon">\${icon}</span>
                        <span class="file-name" title="\${filename}">\&lrm;\${filename}</span>
                    </div>
                    <button class="delete-btn" onclick="deleteFile('\${filename}')" title="Удалить файл из RAG">🗑</button>
                \`;
                filesList.appendChild(item);
            });
        }

        // Удалить файл из RAG
        async function deleteFile(filename) {
            if (!confirm('Вы уверены, что хотите удалить файл "' + filename + '" из базы знаний?')) {
                return;
            }
            
            showToast('Удаление файла...', 'success');
            try {
                const response = await fetch('http://localhost:8000/admin/kb-files/' + encodeURIComponent(filename), {
                    method: 'DELETE'
                });
                
                const result = await response.json();
                if (response.ok) {
                    showToast('Файл "' + filename + '" успешно удален!', 'success');
                    loadFiles();
                } else {
                    showToast('Ошибка удаления: ' + result.detail, 'error');
                }
            } catch (err) {
                showToast('Не удалось связаться с сервером для удаления.', 'error');
            }
        }

        // Drag & Drop
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, e => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, e => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
            }, false);
        });

        dropZone.addEventListener('drop', e => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files.length) uploadFile(files[0]);
        });

        fileInput.addEventListener('change', e => {
            if (fileInput.files.length) uploadFile(fileInput.files[0]);
        });

        // Загрузка файла на Python Бэкенд
        async function uploadFile(file) {
            showToast('Загрузка файла: ' + file.name + '...', 'success');
            
            const formData = new FormData();
            formData.append('file', file);

            try {
                const response = await fetch('http://localhost:8000/admin/upload-kb', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    showToast('Файл "' + file.name + '" успешно проиндексирован в RAG!', 'success');
                    loadFiles();
                } else {
                    const errMsg = result.detail || 'Неизвестная ошибка сервера';
                    showToast('Ошибка загрузки: ' + translateError(errMsg), 'error');
                }
            } catch (err) {
                showToast('Ошибка сети. Проверьте запущен ли Python Backend.', 'error');
            }
        }

        // Перевод некоторых типичных ошибок на русский
        function translateError(msg) {
            if (msg.includes('Incorrect API key provided')) {
                return 'Неверный API-ключ OpenAI. Проверьте файл .env.';
            }
            if (msg.includes('Missing credentials')) {
                return 'Отсутствует API-ключ OpenAI. Укажите его в .env.';
            }
            if (msg.includes('Not supported')) {
                return 'Этот формат файла не поддерживается для базы знаний.';
            }
            return msg;
        }

        // Всплывающие уведомления (Toaster)
        function showToast(message, type) {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.innerHTML = (type === 'success' ? '✅' : '❌') + ' <span>' + message + '</span>';
            container.appendChild(toast);
            
            setTimeout(() => toast.classList.add('show'), 100);
            
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, 4000);
        }

        // Копирование логов в буфер обмена
        async function copyLogs() {
            const text = logsBox.innerText;
            try {
                await navigator.clipboard.writeText(text);
                const btn = document.getElementById('copy-btn');
                btn.innerText = 'Скопировано!';
                btn.style.borderColor = 'var(--success)';
                btn.style.color = 'var(--success)';
                setTimeout(() => {
                    btn.innerText = 'Копировать логи';
                    btn.style.borderColor = 'var(--border-color)';
                    btn.style.color = 'var(--text-color)';
                }, 2000);
            } catch (err) {
                alert('Не удалось скопировать логи.');
            }
        }

        const promptInput = document.getElementById('prompt-input');

        // Загрузка промпта с бэкенда
        async function loadPrompt() {
            try {
                const response = await fetch('http://localhost:8000/admin/prompt');
                if (!response.ok) {
                    throw new Error('Failed to fetch prompt');
                }
                const data = await response.json();
                promptInput.value = data.prompt;
            } catch (err) {
                console.error('Ошибка загрузки промпта:', err);
                showToast('Не удалось загрузить текущий промпт.', 'error');
            }
        }

        // Сохранение промпта
        async function savePrompt() {
            const promptText = promptInput.value.trim();
            if (!promptText) {
                showToast('Промпт не может быть пустым.', 'error');
                return;
            }
            
            const btn = document.getElementById('save-prompt-btn');
            btn.disabled = true;
            btn.innerText = 'Сохранение...';
            
            try {
                const response = await fetch('http://localhost:8000/admin/prompt', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ prompt: promptText })
                });
                
                const result = await response.json();
                if (response.ok) {
                    showToast('Инструкция ИИ успешно обновлена!', 'success');
                } else {
                    showToast('Ошибка сохранения: ' + result.detail, 'error');
                }
            } catch (err) {
                showToast('Не удалось сохранить промпт. Проверьте backend.', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = 'Сохранить промпт';
            }
        }

        // Сброс промпта
        async function resetPromptToDefault() {
            if (!confirm('Вы уверены, что хотите сбросить промпт к стандартным настройкам?')) {
                return;
            }
            
            const defaultPrompt = \`Вы — ИИ-ассистент службы автоматизированной поддержки клиентов. Отвечайте пользователю строго на основе предоставленных документов из Базы Знаний.
ПРАВИЛА:
1. База Знаний — ваш единственный источник истины.
2. Если предоставленные документы содержат точный ответ на вопрос пользователя, ответьте подробно и вежливо. Установите высокий уровень уверенности (confidence > 0.8).
3. Если в документах нет информации для ответа на вопрос или она неполная, установите confidence < 0.5. Напишите, что вы не смогли найти точное решение в инструкциях.
4. Категорически запрещено выдумывать шаги, адреса, телефоны или инструкции, которых нет в Базе Знаний.
5. Принимайте во внимание историю переписки для понимания контекста.
6. Обязательно сохраняйте и используйте форматирование текста для WhatsApp (жирный шрифт, курсив), как в Базе Знаний. Для жирного шрифта выделяйте ключевые слова, кнопки, названия разделов и контакты с помощью одиночных звездочек: *текст* (например, *Настройки*, *Обновить*, *Марии*). Категорически запрещено использовать двойные звездочки (**текст**), так как WhatsApp их не поддерживает. Для курсива используйте нижние подчеркивания: _текст_.\`;
            
            promptInput.value = defaultPrompt;
            await savePrompt();
        }

        // Инициализация при старте
        setInterval(checkStatus, 3000);
        setInterval(loadLogs, 2000);
        checkStatus();
        loadFiles();
        loadLogs();
        loadPrompt();
    </script>
</body>
</html>
  `;
});

// Start Fastify and connection
const start = async () => {
  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    await connectToWhatsApp();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
