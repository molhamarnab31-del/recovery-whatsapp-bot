const INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID || "instance196856";
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN || "mo80gsgf14b3ijmg";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DRIVER_PHONE = process.env.DRIVER_PHONE || "971507245242";
const PHONE_DISPLAY = process.env.PHONE_DISPLAY || "+971563879308";

async function sendWhatsAppMessage(to, body) {
  try {
    const params = new URLSearchParams({ token: ULTRAMSG_TOKEN, to, body });
    await fetch(`https://api.ultramsg.com/${INSTANCE_ID}/messages/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  } catch (err) {
    console.error("UltraMsg Error:", err);
  }
}

async function askGemini(userText, senderName) {
  try {
    if (!GEMINI_API_KEY) {
      return "مرحباً بك في ريكفري الإمارات 🚗\nيرجى إرسال موقعك المباشر GPS ونوع سيارتك لنرسل لك أقرب سطحة فوراً، أو الاتصال المباشر على: " + PHONE_DISPLAY;
    }

    const prompt = `أنت المساعد الذكي الآلي لخدمة "ريكفري الإمارات" (خدمة سطحة وونش وسحب سيارات 24/7 في كل إمارات الدولة).
رقم الطوارئ المباشر: ${PHONE_DISPLAY}
الأسعار تبدأ من 150 درهم، والوصول خلال 15-30 دقيقة.

هدف المحادثة:
1. الرد بلباقة واحترافية باللهجة العربية/الإماراتية البسيطة.
2. طلب شيئين أساسيين فوراً من الزبون ليتحرك السائق إليه:
   - إرسال موقعه المباشر عبر واتساب (اللوكيشن / Live Location).
   - توضيح نوع السيارة وحالة العطل (عطل ميكانيكي، حادث، غرز بالرمال).
3. إجابة سريعة ومختصرة جداً (سطرين إلى 3 أسطر فقط).

رسالة الزبون (${senderName || "العميل"}): "${userText}"`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 150 },
        }),
      }
    );

    if (!res.ok) {
      return "مرحباً بك في ريكفري الإمارات 🚗\nيرجى إرسال موقعك المباشر GPS ونوع سيارتك لنرسل لك أقرب سطحة فوراً، أو الاتصال المباشر على: " + PHONE_DISPLAY;
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "أهلاً بك! يرجى إرسال اللوكيشن لنرسل لك أقرب ونش فوراً.";
  } catch (e) {
    return "مرحباً بك في ريكفري الإمارات! يرجى إرسال موقعك المباشر GPS ونوع سيارتك لنرسل لك أقرب ونش فوراً.";
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).send("Recovery Emirates WhatsApp Bot is Running ✅");
  }

  try {
    const payload = req.body?.data || req.body || {};
    const from = payload.from;
    const fromMe = payload.fromMe;
    const type = payload.type;
    const body = payload.body || "";
    const senderName = payload.pushname || "العميل";

    if (fromMe || !from || from.includes("status@broadcast") || from.includes(DRIVER_PHONE)) {
      return res.status(200).json({ status: "ignored" });
    }

    const cleanSenderNumber = from.replace(/[^0-9]/g, "");

    // 1. Customer shared Location / GPS
    if (type === "location" || (payload.lat && payload.lng)) {
      const lat = payload.lat || payload.latitude;
      const lng = payload.lng || payload.longitude;
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;

      await sendWhatsAppMessage(
        cleanSenderNumber,
        "تم استلام موقعك بنجاح ✅\nأقرب سطحة في طريقها إليك الآن (15-20 دقيقة).\nيرجى كتابة نوع السيارة إذا أمكن."
      );

      const driverAlert = `🚨 طلب ريكفري جديد!\n\n` +
        `👤 الاسم: ${senderName}\n` +
        `📞 رقم الزبون: +${cleanSenderNumber}\n` +
        `📍 موقع الزبون على خرائط جوجل:\n${mapsUrl}\n\n` +
        `💬 تواصل مع الزبون وتحرك فوراً.`;
      await sendWhatsAppMessage(DRIVER_PHONE, driverAlert);

      return res.status(200).json({ status: "location_handled" });
    }

    // 2. Customer sent text
    if (type === "chat" && body.trim()) {
      const mapMatch = body.match(/https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.com|goo\.gl\/maps)[^\s]+/i);
      if (mapMatch) {
        const mapsUrl = mapMatch[0];
        await sendWhatsAppMessage(
          cleanSenderNumber,
          "تم استلام رابط موقعك بنجاح ✅\nأقرب سطحة في طريقها إليك.\nللطوارئ المباشرة: " + PHONE_DISPLAY
        );

        const driverAlert = `🚨 طلب ريكفري جديد (رابط موقع)!\n\n` +
          `👤 الاسم: ${senderName}\n` +
          `📞 رقم الزبون: +${cleanSenderNumber}\n` +
          `📍 موقع الزبون:\n${mapsUrl}\n` +
          `💬 نص رسالة الزبون: "${body}"`;
        await sendWhatsAppMessage(DRIVER_PHONE, driverAlert);
        return res.status(200).json({ status: "map_link_handled" });
      }

      const aiReply = await askGemini(body, senderName);
      await sendWhatsAppMessage(cleanSenderNumber, aiReply);

      const driverNotification = `📢 استفسار ريكفري جديد:\n` +
        `👤 ${senderName} (+${cleanSenderNumber})\n` +
        `💬 قال: "${body}"\n` +
        `🤖 رد البوت: "${aiReply}"`;
      await sendWhatsAppMessage(DRIVER_PHONE, driverNotification);

      return res.status(200).json({ status: "chat_handled" });
    }

    return res.status(200).json({ status: "unhandled_type" });
  } catch (err) {
    console.error("Error:", err);
    return res.status(200).json({ status: "error", error: err.message });
  }
};
