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
 * In-Memory Progress & Results
 **************************************************/
const progressMap = {};

/** Generate a random ID */
function generateRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**************************************************
 * GET /
 **************************************************/
app.get('/', (req, res) => {
  res.send('KasperCoin Website Builder API is running!');
});

/**************************************************
 * POST /start-generation
 **************************************************/
app.post('/start-generation', async (req, res) => {
  const { walletAddress, userInputs } = req.body;
  if (!walletAddress || !userInputs) {
    return res.status(400).json({ error: "walletAddress and userInputs are required." });
  }

  const { coinName, colorPalette, themeSelection, projectDesc } = userInputs;

  // Validate that themeSelection is either "token" or "nft"
  if (!themeSelection || !['token', 'nft'].includes(themeSelection.toLowerCase())) {
    return res.status(400).json({ error: "themeSelection must be either 'token' or 'nft'." });
  }

  try {
    // Decrement 1 credit
    const user = await User.findOneAndUpdate(
      { walletAddress, credits: { $gte: 1 } },
      { $inc: { credits: -1 } },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ error: "Insufficient credits or invalid wallet address." });
    }

    const requestId = generateRequestId();
    progressMap[requestId] = {
      status: 'in-progress',
      progress: 0,
      code: null,
      images: {} // will store base64 images here
    };

    // Start background generation
    doWebsiteGeneration(requestId, userInputs, user).catch(err => {
      console.error("Background generation error:", err);
      progressMap[requestId].status = 'error';
      progressMap[requestId].progress = 100;

      // Refund credit if there's an error
      User.findOneAndUpdate({ walletAddress }, { $inc: { credits: 1 } })
        .then(() => {
          console.log(`Refunded 1 credit to ${walletAddress} due to generation failure.`);
        })
        .catch(refundErr => {
          console.error(`Failed to refund credit for user ${walletAddress}:`, refundErr);
        });
    });

    return res.json({ requestId });
  } catch (err) {
    console.error("Error starting generation:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**************************************************
 * GET /progress?requestId=XYZ
 **************************************************/
app.get('/progress', (req, res) => {
  const { requestId } = req.query;
  if (!requestId || !progressMap[requestId]) {
    return res.status(400).json({ error: "Invalid or missing requestId" });
  }
  const { status, progress } = progressMap[requestId];
  return res.json({ status, progress });
});

/**************************************************
 * GET /result?requestId=XYZ
 * Returns final HTML, with placeholders replaced by in-memory images
 **************************************************/
app.get('/result', (req, res) => {
  const { requestId } = req.query;
  if (!requestId || !progressMap[requestId]) {
    return res.status(400).json({ error: "Invalid or missing requestId" });
  }

  const { status, code, images } = progressMap[requestId];
  if (status !== 'done') {
    return res.status(400).json({ error: "Not finished or generation error." });
  }

  // On-the-fly replace placeholders with base64 from in-memory
  let finalCode = code;
  if (images.navLogo) {
    finalCode = finalCode.replace(/NAV_IMAGE_PLACEHOLDER/g, images.navLogo);
  }
  if (images.heroBg) {
    finalCode = finalCode.replace(/HERO_BG_PLACEHOLDER/g, images.heroBg);
  }
  if (images.footerImg) {
    finalCode = finalCode.replace(/FOOTER_IMAGE_PLACEHOLDER/g, images.footerImg);
  }

  return res.json({ code: finalCode });
});

/**************************************************
 * GET /export?requestId=XYZ&type=full|wordpress
 * Replaces placeholders with in-memory images, then returns
 **************************************************/
app.get('/export', (req, res) => {
  const { requestId, type } = req.query;
  if (!requestId || !progressMap[requestId]) {
    return res.status(400).json({ error: "Invalid or missing requestId" });
  }

  const { status, code, images } = progressMap[requestId];
  if (status !== 'done') {
    return res.status(400).json({ error: "Generation not completed or encountered an error." });
  }

  if (!type || !['full', 'wordpress'].includes(type)) {
    return res.status(400).json({ error: "Invalid or missing export type. Use 'full' or 'wordpress'." });
  }

  // Replace placeholders with in-memory images
  let finalCode = code;
  if (images.navLogo) {
    finalCode = finalCode.replace(/NAV_IMAGE_PLACEHOLDER/g, images.navLogo);
  }
  if (images.heroBg) {
    finalCode = finalCode.replace(/HERO_BG_PLACEHOLDER/g, images.heroBg);
  }
  if (images.footerImg) {
    finalCode = finalCode.replace(/FOOTER_IMAGE_PLACEHOLDER/g, images.footerImg);
  }

  const filename = sanitizeFilename(requestId);

  if (type === 'full') {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}_website.html"`);
    return res.send(finalCode);
  } else {
    const wordpressTemplate = `<?php
/**
 * Template Name: ${filename}_Generated_Website
 */
get_header(); ?>

<div id="generated-website">
${finalCode}
</div>

<?php get_footer(); ?>
`;
    res.setHeader('Content-Type', 'application/php');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}_generated_website.php"`);
    return res.send(wordpressTemplate);
  }
});

/**************************************************
 * GET /get-credits?walletAddress=XYZ
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
    console.error("Error fetching credits:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * POST /create-wallet
 **************************************************/
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
    if (err.code === 11000 && err.keyPattern && err.keyPattern.username) {
      return res.status(400).json({ success: false, error: "Username already exists. Please choose another one." });
    }
    console.error("Error creating wallet:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * POST /connect-wallet
 **************************************************/
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

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
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
    console.error("Error connecting wallet:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * POST /scan-deposits
 **************************************************/
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
    console.error("Error scanning deposits on demand:", err);
    return res.status(500).json({ success: false, error: "Failed to scan deposits" });
  }
});

/**************************************************
 * POST /save-generated-file
 **************************************************/
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
    console.error("Error saving generated file:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * GET /get-user-generations?walletAddress=XYZ
 **************************************************/
app.get('/get-user-generations', async (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) {
    return res.status(400).json({ success: false, error: "Missing walletAddress." });
  }

  console.log("→ /get-user-generations => walletAddress:", walletAddress);

  try {
    // .lean() => faster
    const user = await User.findOne({ walletAddress }).lean();
    console.log("   Found user =>", user ? user._id : "None");

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const files = user.generatedFiles || [];
    console.log("   user.generatedFiles length:", files.length);

    res.setHeader('Content-Type', 'application/json');
    req.setTimeout(0);
    res.setTimeout(0);

    res.write('{"success":true,"generatedFiles":[');

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const fileObj = {
        requestId: f.requestId,
        content: f.content,
        generatedAt: f.generatedAt
      };

      if (i > 0) {
        res.write(',');
      }

      res.write(JSON.stringify(fileObj));
      await new Promise(resolve => setImmediate(resolve));
    }

    res.write(']}');
    res.end();
  } catch (err) {
    console.error("Error in get-user-generations:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

/**************************************************
 * The main background generation function
 **************************************************/
async function doWebsiteGeneration(requestId, userInputs, user) {
  try {
    const { coinName, colorPalette, themeSelection, projectDesc } = userInputs || {};
    if (!coinName || !colorPalette || !themeSelection) {
      throw new Error("Missing 'coinName', 'colorPalette', or 'themeSelection'.");
    }

    progressMap[requestId].progress = 10;

    // We'll store GPT messages for both "token" and "nft" logic.

    // 1) Example snippet for partial inspiration
    const snippetInspiration = `
<html>
<head>
  <style>
    /* Example gradient & shimmer */
    body {
      margin: 0; padding: 0;
      font-family: sans-serif;
    }
    .shimmer-bg {
      background: linear-gradient(90deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0.1) 100%);
      background-size: 200% 200%;
      animation: shimmerMove 2s infinite;
    }
    @keyframes shimmerMove {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
  </style>
</head>
<body>
  <!-- snippet with shimmer -->
</body>
</html>
`;

    // 2) System prompt for a TOKEN site (the old logic)
    const tokenSystemPrompt = `
You are GPT-4o, an advanced website-building AI. Create a single-page HTML/CSS/JS site:

- Use a gradient of "${colorPalette}" for an engaging color scheme, implementing advanced glassmorphism, transitions, etc.
- Focus on a new memecoin token named "${coinName}" with project description "${projectDesc}".
- The site must include these placeholders for images:
  - NAV_IMAGE_PLACEHOLDER (256x256 token logo)
  - HERO_BG_PLACEHOLDER (1024x1024 hero background)
  - FOOTER_IMAGE_PLACEHOLDER (256x256, same as NAV_IMAGE_PLACEHOLDER)
- Must be fully responsive, advanced transitions, shimmer, glass, etc.
- Use snippet below for partial inspiration (no code fences):
${snippetInspiration}
`;

    // 3) System prompt for an NFT site (the NEW logic)
    const nftSystemPrompt = `
You are GPT-4o, an advanced website-building AI. Create a single-page HTML/CSS/JS site:

- Use a gradient of "${colorPalette}" for an engaging color scheme, with advanced glassmorphism and transitions.
- Focus on an NFT collection called "${coinName}" with the description "${projectDesc}".
- The site must emphasize collectible artwork, NFT rarity, and a mint section (dummy button) for examples.
- Must be fully responsive, advanced transitions, shimmer, glass, etc.
- Include these placeholders for images:
  - NAV_IMAGE_PLACEHOLDER (256x256 NFT brand logo)
  - HERO_BG_PLACEHOLDER (1024x1024 hero background or NFT banner)
  - FOOTER_IMAGE_PLACEHOLDER (same as NAV_IMAGE_PLACEHOLDER)
- Use snippet below for partial inspiration (no code fences):
${snippetInspiration}
`;

    // Decide which system prompt to use based on themeSelection
    let systemMessage = null;
    if (themeSelection.toLowerCase() === 'token') {
      systemMessage = tokenSystemPrompt;
    } else {
      systemMessage = nftSystemPrompt;
    }

    progressMap[requestId].progress = 20;

    // 1) ChatCompletion => generate site code with placeholders
    const gptResponse = await openai.createChatCompletion({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemMessage },
        {
          role: "user",
          content: `Generate the single-file site now with placeholders: NAV_IMAGE_PLACEHOLDER, HERO_BG_PLACEHOLDER, FOOTER_IMAGE_PLACEHOLDER. No leftover code fences. Keep it extremely modern and visually stunning.`
        }
      ],
      max_tokens: 3500,
      temperature: 0.9
    });

    let siteCode = gptResponse.data.choices[0].message.content.trim();
    progressMap[requestId].progress = 40;

    // We'll store images in memory only (so DB doesn't bloat)
    const imagesObj = {};

    /***************************************************
     * Generate images differently for Token vs NFT
     **************************************************/
    // Logo prompt
    let logoPrompt;
    let heroPrompt;

    if (themeSelection.toLowerCase() === 'token') {
      logoPrompt = `256x256 transparent token logo for a memecoin called "${coinName}". 
color palette: "${colorPalette}". 
No extra text or background. Fun, playful, circular design.`;
      heroPrompt = `1024x1024 futuristic token-themed background with gradient of "${colorPalette}". Subtle reference to "${coinName}" and "${projectDesc}".`;
    } else {
      // NFT
      logoPrompt = `256x256 unique NFT collection logo for "${coinName}". 
color palette: "${colorPalette}". 
No extra text or background. Vibrant, collectible style.`;
      heroPrompt = `1024x1024 NFT banner background with gradient of "${colorPalette}". Some subtle referencing to "${coinName}" and NFT aesthetics.`;
    }

    // Generate 256x256 logo
    try {
      progressMap[requestId].progress = 45;
      const logoResp = await openai.createImage({ prompt: logoPrompt, n:1, size:"256x256" });
      const logoUrl = logoResp.data.data[0].url;
      const logoFetch = await fetch(logoUrl);
      const logoBuffer = await logoFetch.arrayBuffer();
      const base64Logo = "data:image/png;base64," + Buffer.from(logoBuffer).toString("base64");
      imagesObj.navLogo = base64Logo;      // for NAV_IMAGE_PLACEHOLDER
      imagesObj.footerImg = base64Logo;    // for FOOTER_IMAGE_PLACEHOLDER
    } catch (err) {
      console.error("Nav/Footer logo error:", err);
      // fallback
      const fallback = "data:image/png;base64,iVBORw0K...";
      imagesObj.navLogo = fallback;
      imagesObj.footerImg = fallback;
    }

    // Generate 1024x1024 hero background
    try {
      progressMap[requestId].progress = 55;
      const bgResp = await openai.createImage({ prompt: heroPrompt, n:1, size:"1024x1024" });
      const bgUrl = bgResp.data.data[0].url;
      const bgFetch = await fetch(bgUrl);
      const bgBuffer = await bgFetch.arrayBuffer();
      imagesObj.heroBg = "data:image/png;base64," + Buffer.from(bgBuffer).toString("base64");
    } catch (err) {
      console.error("Hero BG error:", err);
      imagesObj.heroBg = "data:image/png;base64,iVBORw0K...";
    }

    progressMap[requestId].progress = 60;

    // Remove leftover code fences
    siteCode = siteCode.replace(/```+/g, "");

    // We do NOT replace placeholders in the DB-stored code
    progressMap[requestId].code = siteCode;
    progressMap[requestId].images = imagesObj;
    progressMap[requestId].status = "done";
    progressMap[requestId].progress = 100;

    // Save placeholder version to DB
    user.generatedFiles.push({
      requestId,
      content: siteCode,  // placeholders remain in DB
      generatedAt: new Date()
    });
    await user.save();

  } catch (error) {
    console.error("Error in background generation:", error);
    progressMap[requestId].status = "error";
    progressMap[requestId].progress = 100;
  }
}


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
