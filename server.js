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
 * POST /start-generation (full site, 1 credit)
 **************************************************/
app.post('/start-generation', async (req, res) => {
  const { walletAddress, userInputs } = req.body;
  if (!walletAddress || !userInputs) {
    return res.status(400).json({ error: "walletAddress and userInputs are required." });
  }

  const { coinName, colorPalette, projectType, themeSelection, projectDesc } = userInputs;
  if (!projectType || !['nft','token'].includes(projectType.toLowerCase())) {
    return res.status(400).json({ error: "projectType must be 'nft' or 'token'." });
  }
  if (!themeSelection || !['dark','light'].includes(themeSelection.toLowerCase())) {
    return res.status(400).json({ error: "themeSelection must be 'dark' or 'light'." });
  }

  try {
    // Deduct 1 credit
    const user = await User.findOneAndUpdate(
      { walletAddress, credits: { $gte: 1 } },
      { $inc: { credits: -1 } },
      { new: true }
    );
    if(!user){
      return res.status(400).json({ error:"Insufficient credits or invalid wallet address."});
    }

    const requestId= generateRequestId();
    progressMap[requestId]={
      status:'in-progress',
      progress:0,
      code:null,
      images:{}
    };

    doWebsiteGeneration(requestId, userInputs, user).catch(err=>{
      console.error("Background generation error:", err);
      progressMap[requestId].status='error';
      progressMap[requestId].progress=100;
      // Refund
      User.findOneAndUpdate({walletAddress},{ $inc:{ credits:1 } })
      .catch(refundErr=> console.error("Failed to refund credit:", refundErr));
    });

    return res.json({ requestId });
  } catch(err){
    console.error("Error starting generation:", err);
    return res.status(500).json({ error:"Internal server error."});
  }
});

/**************************************************
 * GET /progress?requestId=XYZ
 **************************************************/
app.get('/progress',(req,res)=>{
  const {requestId}=req.query;
  if(!requestId||!progressMap[requestId]){
    return res.status(400).json({error:"Invalid or missing requestId"});
  }
  const {status,progress}= progressMap[requestId];
  return res.json({status,progress});
});

/**************************************************
 * GET /result?requestId=XYZ
 **************************************************/
app.get('/result',(req,res)=>{
  const {requestId}= req.query;
  if(!requestId||!progressMap[requestId]){
    return res.status(400).json({error:"Invalid or missing requestId"});
  }
  const {status, code, images}= progressMap[requestId];
  if(status!=='done'){
    return res.status(400).json({error:"Not finished or generation error."});
  }
  let finalCode= code;
  if(images.navLogo){
    finalCode= finalCode.replace(/NAV_IMAGE_PLACEHOLDER/g, images.navLogo);
  }
  if(images.heroBg){
    finalCode= finalCode.replace(/HERO_BG_PLACEHOLDER/g, images.heroBg);
  }
  if(images.footerImg){
    finalCode= finalCode.replace(/FOOTER_IMAGE_PLACEHOLDER/g, images.footerImg);
  }
  return res.json({ code: finalCode});
});

/**************************************************
 * GET /export?requestId=XYZ&type=full|wordpress
 **************************************************/
app.get('/export',(req,res)=>{
  const {requestId, type}=req.query;
  if(!requestId||!progressMap[requestId]){
    return res.status(400).json({error:"Invalid or missing requestId"});
  }
  const {status,code,images}= progressMap[requestId];
  if(status!=='done'){
    return res.status(400).json({error:"Generation not completed or encountered an error."});
  }
  if(!type||!['full','wordpress'].includes(type)){
    return res.status(400).json({error:"Invalid or missing export type. Use 'full' or 'wordpress'."});
  }
  let finalCode= code;
  if(images.navLogo){
    finalCode= finalCode.replace(/NAV_IMAGE_PLACEHOLDER/g, images.navLogo);
  }
  if(images.heroBg){
    finalCode= finalCode.replace(/HERO_BG_PLACEHOLDER/g, images.heroBg);
  }
  if(images.footerImg){
    finalCode= finalCode.replace(/FOOTER_IMAGE_PLACEHOLDER/g, images.footerImg);
  }
  const filename= sanitizeFilename(requestId);
  if(type==='full'){
    res.setHeader('Content-Type','text/html');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}_website.html"`);
    return res.send(finalCode);
  } else {
    const wpTemplate= `<?php
/**
 * Template Name: ${filename}_Generated_Website
 */
get_header(); ?>

<div id="generated-website">
${finalCode}
</div>

<?php get_footer(); ?>
`;
    res.setHeader('Content-Type','application/php');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}_generated_website.php"`);
    return res.send(wpTemplate);
  }
});

/**************************************************
 * GET /get-credits?walletAddress=XYZ
 **************************************************/
app.get('/get-credits', async(req,res)=>{
  const {walletAddress}=req.query;
  if(!walletAddress){
    return res.status(400).json({success:false,error:"walletAddress is required."});
  }
  try{
    const user= await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({success:false,error:"Invalid wallet address."});
    }
    return res.json({success:true, credits:user.credits});
  }catch(err){
    console.error("Error fetching credits:",err);
    return res.status(500).json({success:false,error:"Internal server error."});
  }
});

/**************************************************
 * POST /create-wallet
 **************************************************/
app.post('/create-wallet', async(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password){
    return res.status(400).json({success:false,error:"Username and password are required."});
  }
  try{
    const existingUser= await User.findOne({username});
    if(existingUser){
      return res.status(400).json({success:false,error:"Username already exists. Please choose another one."});
    }
    const walletData= await createWallet();
    if(!walletData.success){
      return res.status(500).json({success:false,error:"Wallet creation failed."});
    }
    const {receivingAddress,xPrv,mnemonic}= walletData;
    const saltRounds=10;
    const passwordHash= await bcrypt.hash(password,saltRounds);

    const newUser=new User({
      username,
      walletAddress:receivingAddress,
      passwordHash,
      xPrv,
      mnemonic,
      credits:1,
      generatedFiles:[]
    });
    await newUser.save();
    return res.json({success:true, walletAddress:receivingAddress});
  }catch(err){
    if(err.code===11000 && err.keyPattern && err.keyPattern.username){
      return res.status(400).json({success:false,error:"Username already exists. Please choose another one."});
    }
    console.error("Error creating wallet:",err);
    return res.status(500).json({success:false,error:"Internal server error."});
  }
});

/**************************************************
 * POST /connect-wallet
 **************************************************/
app.post('/connect-wallet', async(req,res)=>{
  const {walletAddress,password}= req.body;
  if(!walletAddress||!password){
    return res.status(400).json({success:false,error:"Wallet address and password are required."});
  }
  try{
    const user= await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({success:false,error:"Invalid wallet address or password."});
    }
    const passwordMatch= await bcrypt.compare(password,user.passwordHash);
    if(!passwordMatch){
      return res.status(400).json({success:false,error:"Invalid wallet address or password."});
    }
    return res.json({
      success:true,
      username:user.username,
      walletAddress:user.walletAddress,
      credits:user.credits,
      generatedFiles:user.generatedFiles
    });
  }catch(err){
    console.error("Error connecting wallet:",err);
    return res.status(500).json({success:false,error:"Internal server error."});
  }
});

/**************************************************
 * POST /scan-deposits
 **************************************************/
app.post('/scan-deposits', async(req,res)=>{
  const {walletAddress}= req.body;
  if(!walletAddress){
    return res.status(400).json({success:false,error:"Missing walletAddress"});
  }
  try{
    await fetchAndProcessUserDeposits(walletAddress);
    const user= await User.findOne({walletAddress});
    if(!user){
      return res.status(404).json({success:false,error:"User not found"});
    }
    return res.json({success:true,credits:user.credits});
  }catch(err){
    console.error("Error scanning deposits on demand:",err);
    return res.status(500).json({success:false,error:"Failed to scan deposits"});
  }
});

/**************************************************
 * POST /save-generated-file
 **************************************************/
app.post('/save-generated-file',async(req,res)=>{
  const {walletAddress,requestId,content}=req.body;
  if(!walletAddress||!requestId||!content){
    return res.status(400).json({success:false,error:"All fields are required."});
  }
  try{
    const user= await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({success:false,error:"Invalid wallet address."});
    }
    user.generatedFiles.push({
      requestId,
      content,
      generatedAt:new Date()
    });
    await user.save();
    return res.json({success:true});
  }catch(err){
    console.error("Error saving generated file:",err);
    return res.status(500).json({success:false,error:"Internal server error."});
  }
});

/**************************************************
 * GET /get-user-generations?walletAddress=XYZ
 **************************************************/
app.get('/get-user-generations', async(req,res)=>{
  const {walletAddress}= req.query;
  if(!walletAddress){
    return res.status(400).json({success:false,error:"Missing walletAddress."});
  }
  try{
    const user= await User.findOne({walletAddress}).lean();
    if(!user){
      return res.status(404).json({success:false,error:"User not found."});
    }
    const files=user.generatedFiles||[];
    res.setHeader('Content-Type','application/json');
    req.setTimeout(0);
    res.setTimeout(0);

    res.write('{"success":true,"generatedFiles":[');
    for(let i=0;i<files.length;i++){
      if(i>0)res.write(',');
      res.write(JSON.stringify({
        requestId:files[i].requestId,
        content:files[i].content,
        generatedAt:files[i].generatedAt
      }));
      await new Promise(resolve=>setImmediate(resolve));
    }
    res.write(']}');
    res.end();
  }catch(err){
    console.error("Error in get-user-generations:",err);
    return res.status(500).json({success:false,error:"Internal server error."});
  }
});

/**************************************************
 * MAIN background generation function
 * Increased max_tokens => 4000 for bigger GPT responses
 **************************************************/
async function doWebsiteGeneration(requestId, userInputs, user){
  try{
    const { coinName, colorPalette, projectType, themeSelection, projectDesc}= userInputs||{};
    progressMap[requestId].progress=10;

    const snippetInspiration=`
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
      0% { background-position:-200% 0;}
      100%{ background-position:200% 0;}
    }
  </style>
</head>
<body>
  <!-- snippet with shimmer -->
</body>
</html>
`;

    let systemPrompt;
    if(projectType.toLowerCase()==='nft'){
      systemPrompt=`
You are GPT-4. Generate a single-page HTML/CSS/JS site for an NFT project named "${coinName}", 
with color palette "${colorPalette}" and a ${themeSelection} theme.
It MUST have 7 sections: 
1) <!-- SECTION: nav -->
2) <!-- SECTION: hero -->
3) <!-- SECTION: roadmap -->
4) <!-- SECTION: tokenomics -->
5) <!-- SECTION: exchanges -->
6) <!-- SECTION: about -->
7) <!-- SECTION: footer -->

Use placeholders: NAV_IMAGE_PLACEHOLDER, HERO_BG_PLACEHOLDER, FOOTER_IMAGE_PLACEHOLDER.
Use snippet for partial inspiration:
${snippetInspiration}
ProjectDesc: ${projectDesc}
No leftover code fences.
`;
    } else {
      systemPrompt=`
You are GPT-4. Generate a single-page HTML/CSS/JS site for a memecoin token named "${coinName}", 
with color palette "${colorPalette}" and a ${themeSelection} theme.
It MUST have 7 sections: 
1) <!-- SECTION: nav -->
2) <!-- SECTION: hero -->
3) <!-- SECTION: roadmap -->
4) <!-- SECTION: tokenomics -->
5) <!-- SECTION: exchanges -->
6) <!-- SECTION: about -->
7) <!-- SECTION: footer -->

Use placeholders: NAV_IMAGE_PLACEHOLDER, HERO_BG_PLACEHOLDER, FOOTER_IMAGE_PLACEHOLDER.
Use snippet for partial inspiration:
${snippetInspiration}
ProjectDesc: ${projectDesc}
No leftover code fences.
`;
    }

    progressMap[requestId].progress=20;

    const gptResponse= await openai.createChatCompletion({
      model:"gpt-4o",
      messages:[
        {role:"system", content:systemPrompt},
        {
          role:"user",
          content:`Generate the single HTML file with EXACT comment markers for each section. 
Ensure each block has <!-- SECTION: nav --> ... <!-- END: nav -->, etc. No leftover code fences. 
Make it visually appealing, transitions, glass style.`
        }
      ],
      max_tokens:4000, // << increased to 4000
      temperature:0.9
    });

    let siteCode= gptResponse.data.choices[0].message.content.trim();
    progressMap[requestId].progress=40;

    const imagesObj={};
    let logoPrompt;
    let heroPrompt;
    if(projectType.toLowerCase()==='nft'){
      logoPrompt= `256x256 NFT style brand logo for "${coinName}", color palette "${colorPalette}", suits a ${themeSelection} background, transparent, no text.`;
      heroPrompt= `1024x1024 NFT banner referencing "${coinName}", color palette "${colorPalette}", for a ${themeSelection} theme, subtle text or shape.`;
    } else {
      logoPrompt= `256x256 memecoin token logo for "${coinName}", color palette "${colorPalette}", suits a ${themeSelection} background, transparent, no text.`;
      heroPrompt= `1024x1024 memecoin banner referencing "${coinName}", color palette "${colorPalette}", for a ${themeSelection} theme, subtle.`;
    }
    // nav/footer
    try{
      progressMap[requestId].progress=45;
      const navResp=await openai.createImage({ prompt: logoPrompt, n:1, size:"256x256"});
      const navUrl= navResp.data.data[0].url;
      const navBuf= await (await fetch(navUrl)).arrayBuffer();
      imagesObj.navLogo= "data:image/png;base64," + Buffer.from(navBuf).toString("base64");
      imagesObj.footerImg= imagesObj.navLogo;
    }catch(err){
      console.error("Nav/Footer logo error:",err);
      const fallback="data:image/png;base64,iVBORw0K...";
      imagesObj.navLogo= fallback;
      imagesObj.footerImg= fallback;
    }

    // hero
    try{
      progressMap[requestId].progress=55;
      const heroResp=await openai.createImage({ prompt:heroPrompt, n:1, size:"1024x1024"});
      const heroUrl=heroResp.data.data[0].url;
      const heroBuf=await (await fetch(heroUrl)).arrayBuffer();
      imagesObj.heroBg= "data:image/png;base64," + Buffer.from(heroBuf).toString("base64");
    }catch(err){
      console.error("Hero BG error:",err);
      imagesObj.heroBg="data:image/png;base64,iVBORw0K...";
    }

    // remove leftover code fences
    siteCode= siteCode.replace(/```+/g,"");
    progressMap[requestId].progress=60;
    progressMap[requestId].code= siteCode;
    progressMap[requestId].images= imagesObj;
    progressMap[requestId].status="done";
    progressMap[requestId].progress=100;

    // Save placeholder version to DB
    user.generatedFiles.push({
      requestId,
      content: siteCode,
      generatedAt:new Date()
    });
    await user.save();
  } catch(error){
    console.error("Error in background generation:",error);
    progressMap[requestId].status="error";
    progressMap[requestId].progress=100;
  }
}

/**************************************************
 * POST /generate-section => refresh single section
 * costs 0.25 credits
 * also set max_tokens=4000
 **************************************************/
app.post('/generate-section', async(req,res)=>{
  const {walletAddress, section, coinName, colorPalette, projectType, themeSelection, projectDesc} = req.body;
  if(!walletAddress||!section){
    return res.status(400).json({error:"Missing walletAddress or section."});
  }
  try{
    const user= await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({error:"Invalid wallet address."});
    }
    if(user.credits<0.25){
      return res.status(400).json({error:"Insufficient credits (need 0.25)."});
    }
    user.credits-=0.25;
    await user.save();

    const systemPrompt=`
You are GPT-4. Generate ONLY the [${section}] snippet for a ${projectType} site named "${coinName}".
Use color palette "${colorPalette}", theme "${themeSelection}".
Wrap it with <!-- SECTION: ${section} --> ... <!-- END: ${section} -->.
Use placeholders if needed: ${section.toUpperCase()}_IMAGE_PLACEHOLDER.
ProjectDesc: ${projectDesc}
No leftover code fences. 
`;
    const gptResp= await openai.createChatCompletion({
      model:"gpt-4o",
      messages:[
        {role:"system", content:systemPrompt},
        {
          role:"user",
          content:`Generate ONLY that section snippet (including <!-- SECTION: ${section} -->). No <html> or <body> tags.`
        }
      ],
      max_tokens:4000, // increased
      temperature:0.9
    });
    let snippet= gptResp.data.choices[0].message.content.trim();
    snippet= snippet.replace(/```+/g,"");

    const imagesObj={};
    if(section.toLowerCase()==='nav'){
      try{
        const navPrompt= `256x256 logo for "${coinName}", color:"${colorPalette}", theme:"${themeSelection}". Transparent, no text.`;
        const navResp= await openai.createImage({prompt:navPrompt,n:1,size:"256x256"});
        const navUrl= navResp.data.data[0].url;
        const navBuf=await (await fetch(navUrl)).arrayBuffer();
        imagesObj.sectionImage= "data:image/png;base64,"+ Buffer.from(navBuf).toString("base64");
      }catch(err){
        console.error("Nav partial generation error:",err);
      }
    } else if(section.toLowerCase()==='hero'){
      try{
        const heroPrompt= `1024x1024 hero banner referencing "${coinName}", color:"${colorPalette}", theme:"${themeSelection}". Subtle. Transparent if possible.`;
        const heroResp= await openai.createImage({prompt:heroPrompt,n:1,size:"1024x1024"});
        const heroUrl= heroResp.data.data[0].url;
        const heroBuf= await (await fetch(heroUrl)).arrayBuffer();
        imagesObj.sectionImage= "data:image/png;base64,"+ Buffer.from(heroBuf).toString("base64");
      }catch(err){
        console.error("Hero partial generation error:",err);
      }
    }
    // etc for other sections
    return res.json({snippet, images: imagesObj, newCredits:user.credits});
  }catch(err){
    console.error("Error in /generate-section:",err);
    return res.status(500).json({error:"Internal server error."});
  }
});

/**************************************************
 * The rest of your wallet endpoints remain same
 **************************************************/
/**************************************************
 * Error Handling
 **************************************************/
app.use((err,req,res,next)=>{
  if(err instanceof SyntaxError){
    console.error("Syntax Error:",err);
    return res.status(400).json({error:"Invalid JSON payload."});
  } else if(err.message && err.message.startsWith('The CORS policy')){
    console.error("CORS Error:",err.message);
    return res.status(403).json({error:err.message});
  }
  console.error("Unhandled Error:",err.stack);
  res.status(500).json({error:"Something went wrong!"});
});

/**************************************************
 * Launch
 **************************************************/
const PORT= process.env.PORT||5000;
app.listen(PORT,()=>{
  console.log(`KasperCoin Website Builder API running on port ${PORT}!`);
});
