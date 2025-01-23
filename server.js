require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Configuration, OpenAIApi } = require('openai');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { createWallet } = require('./wasm_rpc');
const User = require('./models/User');
// Only fetchAndProcessUserDeposits, no initDepositSchedulers
const { fetchAndProcessUserDeposits } = require('./services/depositService');

const app = express();

/**
 * CORS Configuration
 */
const allowedOrigins = [
  'https://www.kaspercoin.net',
  'https://kaspercoin.net',
  'https://kaspercoin.webflow.io',
  'http://localhost:8080'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(bodyParser.json());

// ------------------ Connect to MongoDB ------------------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

// ------------------ OpenAI config ------------------
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**************************************************
 * We store an object for each request:
 *  progressMap[requestId] = {
 *    status: 'in-progress' | 'done' | 'error',
 *    progress: number (0-100),
 *    sections: { nav: string|null, hero: string|null, etc. },
 *    currentSectionIndex: number,
 *    images: {} // optional
 *  }
 **************************************************/
const progressMap = {};

const SECTIONS_ORDER = ["nav","hero","roadmap","tokenomics","exchanges","about","footer"];

/** Generate a random ID */
function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/**************************************************
 * GET /
 **************************************************/
app.get('/', (req, res) => {
  res.send('KasperCoin Website Builder (Live-coded, with refresh) is running!');
});

/**************************************************
 * POST /start-generation
 * Cost: 1 credit
 * Step-by-step generate each of the 7 sections
 **************************************************/
app.post('/start-generation', async (req, res) => {
  const { walletAddress, userInputs } = req.body;
  if (!walletAddress || !userInputs) {
    return res.status(400).json({ error: "walletAddress and userInputs are required." });
  }

  const { coinName, colorPalette, projectType, themeSelection, projectDesc } = userInputs;
  if (!coinName || !colorPalette || !projectType || !themeSelection) {
    return res.status(400).json({ error: "Missing required fields in userInputs." });
  }
  if (!["nft","token"].includes(projectType.toLowerCase())) {
    return res.status(400).json({ error: "projectType must be 'nft' or 'token'." });
  }
  if (!["dark","light"].includes(themeSelection.toLowerCase())) {
    return res.status(400).json({ error: "themeSelection must be 'dark' or 'light'." });
  }

  try {
    // Deduct 1 credit
    const user = await User.findOneAndUpdate(
      { walletAddress, credits: { $gte: 1 } },
      { $inc: { credits: -1 } },
      { new: true }
    );
    if (!user) {
      return res.status(400).json({ error: "Insufficient credits or invalid wallet address." });
    }

    const requestId = generateRequestId();
    // Initialize
    progressMap[requestId] = {
      status: 'in-progress',
      progress: 0,
      sections: {
        nav: null, hero: null, roadmap: null, tokenomics: null, exchanges: null, about: null, footer: null
      },
      currentIndex: 0, // which section we're on
      userInputs,       // store for reference
    };

    // Kick off background generation, each section in sequence
    generateAllSectionsSequential(requestId, user).catch(err => {
      console.error("Error in generateAllSectionsSequential:", err);
      progressMap[requestId].status = "error";
      progressMap[requestId].progress = 100;
      // Refund the credit
      User.findOneAndUpdate({ walletAddress }, { $inc: { credits: 1 } }).catch(()=>{});
    });

    return res.json({ requestId });
  } catch (err) {
    console.error("start-generation error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**************************************************
 * A helper that sequentially calls GPT for each section:
 * nav -> hero -> roadmap -> ...
 **************************************************/
async function generateAllSectionsSequential(requestId, user) {
  const context = progressMap[requestId];
  if (!context) return;

  try {
    const { userInputs } = context;
    for (let i = 0; i < SECTIONS_ORDER.length; i++) {
      const section = SECTIONS_ORDER[i];
      context.currentIndex = i;
      context.progress = Math.floor((i / SECTIONS_ORDER.length) * 100);

      // Generate snippet for that section
      const snippet = await generateSectionSnippet(userInputs, section);
      context.sections[section] = snippet;

      // Optionally update progress
      context.progress = Math.floor(((i+1) / SECTIONS_ORDER.length) * 100);
    }
    // Done
    context.status = "done";
    context.progress = 100;
  } catch (err) {
    console.error("Error generating all sections in sequence:", err);
    context.status = "error";
    context.progress = 100;
  }
}

/**************************************************
 * generateSectionSnippet (like mini GPT call),
 * cost is 0 here because the user already paid 1 credit
 * for the entire site generation.
 **************************************************/
async function generateSectionSnippet(userInputs, section) {
  const { coinName, colorPalette, projectType, themeSelection, projectDesc } = userInputs;
  const systemPrompt = `
You are GPT-4. Generate ONLY the HTML/CSS/JS snippet for [${section}] of a ${projectType} project named "${coinName}". 
Use color palette "${colorPalette}" and a ${themeSelection} theme. 
Wrap the snippet with <!-- SECTION: ${section} --> ... <!-- END: ${section} -->. 
Use placeholders if needed, e.g. ${section.toUpperCase()}_IMAGE_PLACEHOLDER. 
Project description: ${projectDesc}
No leftover code fences.
  `;
  const resp = await openai.createChatCompletion({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Generate ONLY the [${section}] snippet, with the <!-- SECTION: ${section} --> marker. No <html> or <body> tags.`
      }
    ],
    max_tokens: 1200,
    temperature: 0.9
  });
  let snippet = resp.data.choices[0].message.content.trim();
  return snippet.replace(/```+/g, "");
}

/**************************************************
 * GET /progress?requestId=XYZ
 * We'll return the sections generated so far
 **************************************************/
app.get('/progress', (req, res) => {
  const { requestId } = req.query;
  if (!requestId || !progressMap[requestId]) {
    return res.status(400).json({ error: "Invalid or missing requestId" });
  }
  const { status, progress, sections } = progressMap[requestId];
  return res.json({ status, progress, sections });
});

/**************************************************
 * POST /generate-section => REFRESH a single section
 * Cost: 0.25 credits
 **************************************************/
app.post('/generate-section', async (req, res) => {
  try {
    const { walletAddress, section, coinName, colorPalette, projectType, themeSelection, projectDesc } = req.body;
    if (!walletAddress || !section) {
      return res.status(400).json({ error: "Missing walletAddress or section." });
    }
    if (!["nft","token"].includes(projectType.toLowerCase())) {
      return res.status(400).json({ error: "projectType must be 'nft' or 'token'." });
    }
    if (!["dark","light"].includes(themeSelection.toLowerCase())) {
      return res.status(400).json({ error: "themeSelection must be 'dark' or 'light'." });
    }

    // Check user & credits
    const user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(400).json({ error: "Invalid wallet address." });
    }
    if (user.credits < 0.25) {
      return res.status(400).json({ error: "Insufficient credits. Need at least 0.25 to refresh a single section." });
    }

    // Deduct 0.25
    user.credits -= 0.25;
    await user.save();

    // GPT call
    const systemPrompt = `
You are GPT-4. Generate ONLY the [${section}] snippet for a ${projectType} project named "${coinName}".
Use color palette "${colorPalette}" and a ${themeSelection} theme.
Wrap with <!-- SECTION: ${section} --> ... <!-- END: ${section} -->.
Use placeholders if needed, e.g. ${section.toUpperCase()}_IMAGE_PLACEHOLDER.
ProjectDesc: ${projectDesc}
No leftover code fences.
    `;
    const gptResp = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Generate ONLY that snippet. No <html> or <body> tags. Include <!-- SECTION: ${section} --> comment.`
        }
      ],
      max_tokens: 1200,
      temperature: 0.9
    });
    let snippet = gptResp.data.choices[0].message.content.trim();
    snippet = snippet.replace(/```+/g, "");

    // Optionally create an image
    let imagesObj = {};
    if (section.toLowerCase() === 'nav') {
      try {
        const navPrompt = `256x256 logo for "${coinName}" with color: "${colorPalette}" for a ${themeSelection} theme. Transparent. No extra text.`;
        const navImageResp = await openai.createImage({ prompt: navPrompt, n:1, size:"256x256" });
        const navUrl = navImageResp.data.data[0].url;
        const navBuf = await (await fetch(navUrl)).arrayBuffer();
        imagesObj.sectionImage = "data:image/png;base64," + Buffer.from(navBuf).toString("base64");
      } catch (err) {
        console.error("Nav partial generation error:", err);
      }
    } else if (section.toLowerCase() === 'hero') {
      try {
        const heroPrompt = `1024x1024 hero banner referencing "${coinName}", color: "${colorPalette}", theme: "${themeSelection}" transparent style.`;
        const heroResp = await openai.createImage({ prompt: heroPrompt, n:1, size:"1024x1024" });
        const heroUrl = heroResp.data.data[0].url;
        const heroBuf = await (await fetch(heroUrl)).arrayBuffer();
        imagesObj.sectionImage = "data:image/png;base64," + Buffer.from(heroBuf).toString("base64");
      } catch (err) {
        console.error("Hero partial generation error:", err);
      }
    }
    // etc. for other sections

    return res.json({ snippet, images: imagesObj, newCredits: user.credits });
  } catch (err) {
    console.error("Error in /generate-section route:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**************************************************
 * Other wallet/credits endpoints
 **************************************************/

app.get('/get-credits', async (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: "walletAddress is required." });
  }
  try {
    const user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }
    return res.json({ success: true, credits: user.credits });
  } catch (err) {
    console.error("get-credits error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

app.post('/create-wallet', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password are required." });
  }
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ success: false, error: "Username already exists. Please choose another one." });
    }
    const walletData = await createWallet();
    if (!walletData.success) {
      return res.status(500).json({ success: false, error: "Wallet creation failed." });
    }
    const { receivingAddress, xPrv, mnemonic } = walletData;
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newUser = new User({
      username,
      walletAddress: receivingAddress,
      passwordHash,
      xPrv,
      mnemonic,
      credits: 1,
      generatedFiles: []
    });
    await newUser.save();
    return res.json({ success: true, walletAddress: receivingAddress });
  } catch (err) {
    console.error("create-wallet error:", err);
    if (err.code === 11000 && err.keyPattern && err.keyPattern.username) {
      return res.status(400).json({ success: false, error: "Username already exists." });
    }
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

app.post('/connect-wallet', async (req, res) => {
  const { walletAddress, password } = req.body;
  if (!walletAddress || !password) {
    return res.status(400).json({ success: false, error: "Wallet address and password are required." });
  }
  try {
    const user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(400).json({ success: false, error: "Invalid wallet address or password." });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(400).json({ success: false, error: "Invalid wallet address or password." });
    }
    return res.json({
      success: true,
      username: user.username,
      walletAddress: user.walletAddress,
      credits: user.credits,
      generatedFiles: user.generatedFiles
    });
  } catch (err) {
    console.error("connect-wallet error:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

app.post('/scan-deposits', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: "Missing walletAddress" });
  }
  try {
    await fetchAndProcessUserDeposits(walletAddress);
    const user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    return res.json({ success: true, credits: user.credits });
  } catch (err) {
    console.error("scan-deposits error:", err);
    return res.status(500).json({ success: false, error: "Failed to scan deposits" });
  }
});

app.post('/save-generated-file', async (req, res) => {
  const { walletAddress, requestId, content } = req.body;
  if (!walletAddress || !requestId || !content) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }
  try {
    const user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(400).json({ success: false, error: "Invalid wallet address." });
    }
    user.generatedFiles.push({
      requestId,
      content,
      generatedAt: new Date()
    });
    await user.save();
    return res.json({ success: true });
  } catch (err) {
    console.error("save-generated-file error:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

app.get('/get-user-generations', async (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: "Missing walletAddress." });
  }
  try {
    const user = await User.findOne({ walletAddress }).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }
    const files = user.generatedFiles || [];
    res.setHeader('Content-Type', 'application/json');
    req.setTimeout(0);
    res.setTimeout(0);

    res.write('{"success":true,"generatedFiles":[');
    for (let i = 0; i < files.length; i++) {
      if (i > 0) res.write(',');
      res.write(JSON.stringify(files[i]));
      await new Promise(resolve => setImmediate(resolve));
    }
    res.write(']}');
    res.end();
  } catch (err) {
    console.error("get-user-generations error:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * Error Handling
 **************************************************/
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) {
    console.error("Syntax Error:", err);
    return res.status(400).json({ error: "Invalid JSON payload." });
  } else if (err.message && err.message.startsWith('The CORS policy')) {
    console.error("CORS Error:", err.message);
    return res.status(403).json({ error: err.message });
  }
  console.error("Unhandled Error:", err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

/**************************************************
 * Launch
 **************************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`KasperCoin Website Builder API running on port ${PORT}!`);
});
