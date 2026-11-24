const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

async function useRedisAuthState(upstashUrl, upstashToken, prefix = "baileys:") {
  const headers = {
    Authorization: `Bearer ${upstashToken}`,
    "Content-Type": "application/json",
  };

  const pipeline = async (commands) => {
    if (!commands.length) return [];
    const res = await fetch(`${upstashUrl}/pipeline`, {
      method: "POST",
      headers,
      body: JSON.stringify(commands),
    });
    return res.json();
  };

  const readData = async (key) => {
    try {
      const res = await fetch(`${upstashUrl}/get/${encodeURIComponent(prefix + key)}`, {
        headers: { Authorization: `Bearer ${upstashToken}` },
      });
      const data = await res.json();
      if (!data || !data.result) return null;
      return JSON.parse(data.result, BufferJSON.reviver);
    } catch (e) {
      console.error("Redis readData error:", key, e.message);
      return null;
    }
  };

  const writeData = async (key, data) => {
    try {
      const val = JSON.stringify(data, BufferJSON.replacer);
      await fetch(upstashUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(["SET", prefix + key, val]),
      });
    } catch (e) {
      console.error("Redis writeData error:", key, e.message);
    }
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids.length) return data;
          try {
            const cmds = ids.map((id) => ["GET", `${prefix}${type}-${id}`]);
            const results = await pipeline(cmds);
            ids.forEach((id, idx) => {
              let value = results[idx]?.result;
              if (value) {
                value = JSON.parse(value, BufferJSON.reviver);
                if (type === "app-state-sync-key" && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              }
            });
          } catch (e) {
            console.error("Redis keys.get error:", e.message);
          }
          return data;
        },
        set: async (data) => {
          const cmds = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${prefix}${category}-${id}`;
              if (value) {
                cmds.push(["SET", key, JSON.stringify(value, BufferJSON.replacer)]);
              } else {
                cmds.push(["DEL", key]);
              }
            }
          }
          try {
            if (cmds.length) {
              await pipeline(cmds);
            }
          } catch (e) {
            console.error("Redis keys.set error:", e.message);
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData("creds", creds);
    },
    clearAll: async () => {
      try {
        const res = await fetch(`${upstashUrl}/keys/${encodeURIComponent(prefix + "*")}`, {
          headers: { Authorization: `Bearer ${upstashToken}` },
        });
        const data = await res.json();
        const keys = data.result || [];
        if (keys.length) {
          await pipeline(keys.map((k) => ["DEL", k]));
        }
      } catch (e) {
        console.error("Redis clearAll error:", e.message);
      }
    },
  };
}

module.exports = { useRedisAuthState };
