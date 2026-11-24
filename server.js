const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { useRedisAuthState } = require("./redisAuth");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DRIVER_PHONE = process.env.DRIVER_PHONE || "971507245242";

// Upstash Redis configuration
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  "https://excited-flounder-168598.upstash.io";
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  "gQAAAAAAApKWAAIgcDI0YjIzZDU5YWU4MGE0MzE1YWFmOWQ2YmJhNjNhYjIxNw";

// Obfuscated Gemini Key
const DEFAULT_KEY = Buffer.from(
  "QVEuQWI4Uk42S0E0bENCMnNQTU14SmdBOU1QbkVVeDNmMGpkOE1OMDJNbm9RM2lYNDVnbXc=",
  "base64"
).toString("utf-8");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || DEFAULT_KEY;

// Bot State
let sock = null;
let qrCodeDataUrl = null;
let connectionStatus = "starting"; // starting, qr, open, closed
let authControl = null;
const sentMessageIds = new Set();

// Redis Helpers
async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error("Redis Get Error:", e.message);
    return null;
  }
}

async function redisSet(key, value, exSeconds = 7200) {
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, value, "EX", exSeconds]),
    });
  } catch (e) {
    console.error("Redis Set Error:", e.message);
  }
}

// Send WhatsApp Message via Baileys
async function sendWhatsAppMessage(phoneOrJid, text) {
  if (!sock || connectionStatus !== "open") {
    console.error("Cannot send message: WhatsApp not connected");
    return false;
  }
  try {
    const jid = phoneOrJid.includes("@")
      ? phoneOrJid
      : `${phoneOrJid.replace(/[^0-9]/g, "")}@s.whatsapp.net`;

    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      setTimeout(() => sentMessageIds.delete(sent.key.id), 60000);
    }
    return true;
  } catch (err) {
    console.error("Baileys Send Error:", err.message);
    return false;
  }
}

// Gemini AI Reply
async function askGemini(userText, senderName, hasAlreadySentLocation = false) {
  try {
    if (!GEMINI_API_KEY) {
      return hasAlreadySentLocation
        ? "يا هلا بك، موقعك مستلم بالفعل والسائق في طريقه إليك الآن بأقرب سطحة."
        : "يا هلا بك في ريكفري الإمارات.\nفضلاً أرسل موقعك المباشر (اللوكيشن 📍) لنتحرك لك بأقرب سطحة فوراً.";
    }

    const prompt = hasAlreadySentLocation
      ? `أنت المساعد الذكي لخدمة "ريكفري الإمارات" (سطحة وسحب سيارات 24/7).
العميل (${senderName || "الزبون"}) سبق وأن أرسل موقعه (اللوكيشن) وهو مستلم بالفعل والسائق تحرك باتجاهه.
العميل يسأل الآن: "${userText}"
هدف الرد:
1. طمأنة العميل بلباقة واختصار (سطر واحد أو سطرين) أن موقعه مستلم وأن السائق في الطريق إليه الآن.
2. ممنوع نهائياً طلب إرسال الموقع أو اللوكيشن مرة أخرى لأنه أرسله مسبقاً!
3. ممنوع ذكر أي دقائق محددة أو وقت دقيق.
4. ممنوع طلب نوع السيارة أو العطل وممنوع وضع أرقام هواتف.`
      : `أنت المساعد الذكي لخدمة "ريكفري الإمارات" (سطحة وسحب سيارات 24/7).
هدف الرد:
1. الترحيب بلباقة بلهجة إماراتية/عربية بسيطة ومختصرة جداً (سطرين فقط).
2. طلب أمر واحد فقط لا غير من الزبون: إرسال موقعه المباشر (اللوكيشن) عبر واتساب ليتحرك السائق إليه فوراً.
3. ممنوع نهائياً ذكر أي وقت أو دقائق (لا تقل 15 دقيقة ولا غيرها).
4. ممنوع طلب نوع السيارة أو سبب العطل نهائياً.
5. ممنوع كتابة أي رقم هاتف أو عبارة "للاتصال المباشر".

رسالة الزبون (${senderName || "العميل"}): "${userText}"`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
        }),
      }
    );

    if (!res.ok) {
      return hasAlreadySentLocation
        ? "يا هلا بك، موقعك مستلم بالفعل والسائق في طريقه إليك الآن."
        : "يا هلا بك في ريكفري الإمارات.\nفضلاً أرسل موقعك المباشر (اللوكيشن 📍) لنتحرك لك بأقرب سطحة فوراً.";
    }

    const data = await res.json();
    return (
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      (hasAlreadySentLocation
        ? "يا هلا بك، موقعك مستلم بالفعل والسائق في طريقه إليك الآن."
        : "يا هلا بك في ريكفري الإمارات.\nفضلاً أرسل موقعك المباشر (اللوكيشن 📍) لنتحرك لك بأقرب سطحة فوراً.")
    );
  } catch (e) {
    return hasAlreadySentLocation
      ? "يا هلا بك، موقعك مستلم بالفعل والسائق في طريقه إليك الآن."
      : "يا هلا بك في ريكفري الإمارات.\nفضلاً أرسل موقعك المباشر (اللوكيشن 📍) لنتحرك لك بأقرب سطحة فوراً.";
  }
}

// Start Baileys WhatsApp Connection
async function startWhatsApp() {
  try {
    connectionStatus = "starting";
    authControl = await useRedisAuthState(UPSTASH_URL, UPSTASH_TOKEN, "baileys:");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authControl.state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Recovery Emirates", "Chrome", "120.0"],
    });

    sock.ev.on("creds.update", authControl.saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = "qr";
        qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        console.log("📱 QR Code generated! Open the web dashboard to scan.");
      }

      if (connection === "open") {
        connectionStatus = "open";
        qrCodeDataUrl = null;
        console.log("✅ WhatsApp Connected Successfully!");
      }

      if (connection === "close") {
        connectionStatus = "closed";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log("❌ Connection closed. Status:", statusCode, "Reconnect:", shouldReconnect);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("⚠️ Logged out. Clearing Redis session...");
          await authControl.clearAll();
          setTimeout(startWhatsApp, 3000);
        } else if (shouldReconnect) {
          setTimeout(startWhatsApp, 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const jid = msg.key.remoteJid;
          if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) {
            continue;
          }

          // Ignore messages sent by the bot itself
          if (msg.key.fromMe) {
            if (sentMessageIds.has(msg.key.id)) {
              continue; // Bot's own message
            }
            // Owner sent a manual message from their phone -> pause bot for 2 hours
            const targetPhone = (msg.key.remoteJidAlt || jid).replace(/[^0-9]/g, "");
            if (targetPhone && !targetPhone.includes(DRIVER_PHONE)) {
              await redisSet(`paused:${targetPhone}`, "1", 7200);
              console.log(`⏸️ Owner replied manually to ${targetPhone}. Bot paused for 2h.`);
            }
            continue;
          }

          const rawPhoneJid = msg.key.remoteJidAlt || jid;
          const cleanSenderNumber = rawPhoneJid.replace(/[^0-9]/g, "");

          // Ignore messages from the driver
          if (!cleanSenderNumber || cleanSenderNumber.includes(DRIVER_PHONE)) {
            continue;
          }

          // Check if bot is paused for this customer
          const isPaused = await redisGet(`paused:${cleanSenderNumber}`);
          if (isPaused) {
            continue;
          }

          const senderName = msg.pushName || "العميل";
          const m = msg.message;

          // Extract text
          const body = (
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            ""
          ).trim();

          // Check location message
          const loc = m.locationMessage || m.liveLocationMessage;
          const hasMapLink =
            body.includes("maps.google.com") ||
            body.includes("google.com/maps") ||
            body.includes("maps.app.goo.gl") ||
            body.includes("goo.gl/maps") ||
            body.includes("maps.apple.com");

          if (loc || hasMapLink) {
            let mapsUrl = "";
            if (loc && loc.degreesLatitude && loc.degreesLongitude) {
              mapsUrl = `https://www.google.com/maps?q=${loc.degreesLatitude},${loc.degreesLongitude}`;
            } else if (hasMapLink) {
              const linkMatch = body.match(/https?:\/\/[^\s]+/);
              mapsUrl = linkMatch ? linkMatch[0] : body;
            } else {
              mapsUrl = body || "موقع بدون رابط";
            }

            await redisSet(`has_location:${cleanSenderNumber}`, "1", 14400);

            await sendWhatsAppMessage(
              jid,
              "تم استلام موقعك بنجاح ✅ السائق سيتصل بك فوراً."
            );

            const driverAlert =
              `🚨 طلب سطحة جديد!\n\n` +
              `👤 الاسم: ${senderName}\n` +
              `📞 رقم الزبون: +${cleanSenderNumber}\n` +
              `📍 موقع الزبون على خرائط جوجل:\n${mapsUrl}`;
            await sendWhatsAppMessage(DRIVER_PHONE, driverAlert);
            continue;
          }

          // Handle normal text message
          if (body) {
            const hasAlreadySentLocation = await redisGet(`has_location:${cleanSenderNumber}`);
            const aiReply = await askGemini(body, senderName, !!hasAlreadySentLocation);
            await sendWhatsAppMessage(jid, aiReply);
          }
        } catch (err) {
          console.error("Message processing error:", err.message);
        }
      }
    });
  } catch (e) {
    console.error("startWhatsApp error:", e.message);
    setTimeout(startWhatsApp, 5000);
  }
}

// Health check for UptimeRobot
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", whatsapp: connectionStatus });
});
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// Reset / Logout route
app.get("/reset", async (req, res) => {
  if (req.query.secret !== "emirates2026") {
    return res.status(403).send("Invalid secret");
  }
  if (authControl) {
    await authControl.clearAll();
  }
  if (sock) {
    try { sock.end(); } catch (e) {}
  }
  qrCodeDataUrl = null;
  setTimeout(startWhatsApp, 1000);
  res.redirect("/");
});

// Missed Call & SMS Webhook Endpoint (MacroDroid compatible)
app.all("/api", async (req, res) => {
  const query = req.query || {};
  const isMissedCall =
    query.action === "missed_call" || req.body?.action === "missed_call";

  if (!isMissedCall) {
    return res.status(200).json({
      status: "ok",
      whatsapp: connectionStatus,
      message: "Recovery Emirates Cloud Gateway is Running ✅",
    });
  }

  let rawPhone = query.phone || req.body?.phone;
  const smsPhone = query.sms_phone || req.body?.sms_phone;

  if (!rawPhone || String(rawPhone).includes("[") || String(rawPhone).trim() === "") {
    rawPhone = smsPhone;
  }

  const secret = query.secret || req.body?.secret;
  if (secret !== "emirates2026") {
    return res.status(403).json({ error: "Invalid secret key" });
  }

  if (!rawPhone || String(rawPhone).includes("[")) {
    return res.status(400).json({ error: "Phone number required" });
  }

  let cleanPhone = String(rawPhone).replace(/[^0-9]/g, "");
  if (cleanPhone.startsWith("05") && cleanPhone.length === 10) {
    cleanPhone = "971" + cleanPhone.substring(1);
  } else if (cleanPhone.startsWith("5") && cleanPhone.length === 9) {
    cleanPhone = "971" + cleanPhone;
  } else if (cleanPhone.startsWith("00971")) {
    cleanPhone = cleanPhone.substring(2);
  }

  if (cleanPhone.length < 9) {
    return res.status(400).json({ error: "Invalid phone length" });
  }

  const alreadyNotified = await redisGet(`missed_call:${cleanPhone}`);
  if (alreadyNotified) {
    return res.status(200).json({
      status: "already_notified_recently",
      message: "تم تنبيه هذا الرقم مسبقاً خلال آخر 30 دقيقة",
    });
  }

  await redisSet(`missed_call:${cleanPhone}`, "1", 1800);

  const missedCallMsg =
    `مرحباً بك في ريكفري الإمارات\n\n` +
    `هل تحتاج سطحة لنقل سيارتك؟\n` +
    `فضلاً أرسل موقعك المباشر (اللوكيشن 📍) هنا في المحادثة وسيتصل بك أقرب سائق فوراً.`;

  const sent = await sendWhatsAppMessage(cleanPhone, missedCallMsg);
  return res.status(200).json({
    status: sent ? "success" : "queued_or_disconnected",
    notified_phone: cleanPhone,
    whatsapp_status: connectionStatus,
  });
});

// Web Dashboard & QR Code Page
app.get("/", (req, res) => {
  const isConnected = connectionStatus === "open";
  const statusBadge = isConnected
    ? `<span style="background:#dcfce7;color:#166534;padding:8px 18px;border-radius:99px;font-weight:bold;">✅ متصل بالواتساب ويعمل 24/7</span>`
    : connectionStatus === "qr"
    ? `<span style="background:#fef9c3;color:#854d0e;padding:8px 18px;border-radius:99px;font-weight:bold;">⏳ بانتظار مسح رمز الـ QR من هاتفك</span>`
    : `<span style="background:#fee2e2;color:#991b1b;padding:8px 18px;border-radius:99px;font-weight:bold;">🔄 جاري الاتصال بالسيرفر...</span>`;

  const qrSection =
    qrCodeDataUrl && !isConnected
      ? `<div style="margin:24px auto;padding:20px;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);display:inline-block;">
           <img src="${qrCodeDataUrl}" alt="WhatsApp QR Code" style="width:280px;height:280px;display:block;" />
           <p style="margin:12px 0 0;color:#475569;font-size:14px;">افتح واتساب على هاتفك ⬅ الأجهزة المرتبطة ⬅ ربط جهاز وامسح الكود</p>
         </div>`
      : isConnected
      ? `<div style="margin:24px auto;padding:24px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:16px;max-width:420px;">
           <h3 style="margin:0 0 8px;color:#166534;">البوت شغال بنجاح! 🚗</h3>
           <p style="margin:0;color:#15803d;font-size:14px;">يتم الآن الرد على العملاء بالذكاء الاصطناعي واستلام اللوكيشن وإرسال تنبيهات المكالمات الفائتة مجاناً 100%.</p>
         </div>`
      : `<p style="margin:24px;color:#64748b;">يرجى الانتظار بضع ثوانٍ، يتم تجهيز الكود...</p>`;

  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${!isConnected ? '<meta http-equiv="refresh" content="5" />' : ""}
  <title>بوابة ريكفري الإمارات للواتساب</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; text-align: center; padding: 40px 20px; margin: 0; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 36px 24px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 16px; font-size: 24px; color: #0f3567; }
    .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #0f3567; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>سيرفر ريكفري الإمارات الخاص للواتساب</h1>
    <div style="margin: 16px 0;">${statusBadge}</div>
    ${qrSection}
    <div>
      <a href="/reset?secret=emirates2026" class="btn" onclick="return confirm('هل تريد توليد رمز QR جديد؟');">توليد QR جديد / إعادة ضبط الجلسة</a>
    </div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 Recovery Emirates Cloud Gateway running on port ${PORT}`);
  startWhatsApp();
});
