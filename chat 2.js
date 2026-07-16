export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { history, image } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const systemInstruction = {
    parts: [{
      text: "You are SS Life, a warm, quick-witted voice companion talking out loud to a friend. Reply the way a sharp, easygoing person would speak — short natural sentences, no markdown, nothing that looks written rather than said. Usually 1-3 sentences. You have two tools: get_weather and set_reminder. Use them when the person clearly asks for weather or asks to be reminded of something. Otherwise just talk normally. If an image is included, describe or answer about what's actually in it, naturally, like you're looking at it live."
    }]
  };

  const tools = [{
    functionDeclarations: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a place the user names',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: 'City name' } },
          required: ['location']
        }
      },
      {
        name: 'set_reminder',
        description: 'Set a reminder for the user for a number of minutes from now',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'What to remind them about' },
            minutes: { type: 'number', description: 'Minutes from now to remind them' }
          },
          required: ['message', 'minutes']
        }
      }
    ]
  }];

  const contents = history
    .filter(m => m.role !== 'system')
    .map((m, i, arr) => {
      const parts = [{ text: m.content }];
      if (image && i === arr.length - 1 && m.role === 'user') {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

  async function callGemini(contentsToSend) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: contentsToSend,
          systemInstruction,
          tools,
          generationConfig: { temperature: 0.8, maxOutputTokens: 300 }
        })
      }
    );
    return r.json();
  }

  async function getWeather(location) {
    try {
      const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`).then(r => r.json());
      if (!geo.results || !geo.results.length) return `Couldn't find a place called ${location}.`;
      const { latitude, longitude, name } = geo.results[0];
      const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`).then(r => r.json());
      return `Current temperature in ${name} is ${w.current.temperature_2m}°C.`;
    } catch (e) {
      return 'Weather lookup failed.';
    }
  }

  try {
    let data = await callGemini(contents);
    const part = data.candidates?.[0]?.content?.parts?.[0];

    if (part?.functionCall) {
      const { name, args } = part.functionCall;

      if (name === 'get_weather') {
        const weatherText = await getWeather(args.location);
        const followUp = [...contents,
          { role: 'model', parts: [{ functionCall: part.functionCall }] },
          { role: 'user', parts: [{ functionResponse: { name, response: { result: weatherText } } }] }
        ];
        data = await callGemini(followUp);
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || weatherText;
        return res.status(200).json({ reply });
      }

      if (name === 'set_reminder') {
        const reply = `Okay, I'll remind you in ${args.minutes} minutes: ${args.message}`;
        return res.status(200).json({ reply, action: { type: 'set_reminder', message: args.message, minutes: args.minutes } });
      }
    }

    const reply = part?.text?.trim() || "Sorry, I didn't catch that.";
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
