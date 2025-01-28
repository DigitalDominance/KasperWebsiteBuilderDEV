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
  origin: function(origin, callback){
    if(!origin) return callback(null,true);
    if(allowedOrigins.indexOf(origin)===-1){
      const msg=`The CORS policy for this site does not allow access from ${origin}`;
      return callback(new Error(msg),false);
    }
    return callback(null,true);
  },
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["Content-Type","Authorization"]
}));
app.use(bodyParser.json());

// ------------------ Connect to MongoDB ------------------
mongoose.connect(process.env.MONGO_URI,{
  useNewUrlParser:true,
  useUnifiedTopology:true
})
.then(()=> console.log('Connected to MongoDB'))
.catch(err=>{
  console.error('Failed to connect to MongoDB:',err);
  process.exit(1);
});

/**
 * Create an OpenAI client for TEXT completions
 * (Previously called "deepseek", but now it's GPT-4).
 */
const openAiTextConfig = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
  basePath: 'https://api.openai.com/v1'
});
const openAiText = new OpenAIApi(openAiTextConfig);

/**
 * Create another OpenAI client for DALL·E 3 images
 * (We keep them separate, but they use the same API key.)
 */
const openaiImagesConfig = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
  basePath: 'https://api.openai.com/v1'
});
const openaiImages = new OpenAIApi(openaiImagesConfig);

/**************************************************
 * In-Memory
 **************************************************/
const progressMap={};
function generateRequestId(){
  return crypto.randomBytes(8).toString('hex');
}
function sanitizeFilename(name){
  return name.replace(/[^a-zA-Z0-9_-]/g,"_");
}

/**************************************************
 * GET /
 **************************************************/
app.get('/',(req,res)=>{
  res.send('KasperCoin Website Builder API is running!');
});

/**************************************************
 * POST /start-generation (1 credit)
 **************************************************/
app.post('/start-generation', async(req,res)=>{
  const { walletAddress, userInputs }=req.body;
  if(!walletAddress||!userInputs){
    return res.status(400).json({error:"walletAddress and userInputs are required."});
  }
  const { coinName, colorPalette, projectType, themeSelection, projectDesc }= userInputs;
  if(!projectType||!['nft','token'].includes(projectType.toLowerCase())){
    return res.status(400).json({error:"projectType must be 'nft' or 'token'."});
  }
  if(!themeSelection||!['dark','light'].includes(themeSelection.toLowerCase())){
    return res.status(400).json({error:"themeSelection must be 'dark' or 'light'."});
  }

  try{
    // Deduct 1 credit
    const user= await User.findOneAndUpdate(
      {walletAddress,credits:{$gte:1}},
      {$inc:{credits:-1}},
      {new:true}
    );
    if(!user){
      return res.status(400).json({error:"Insufficient credits or invalid wallet address."});
    }

    const requestId= generateRequestId();
    progressMap[requestId]={
      status:'in-progress',
      progress:0,
      code:null,
      images:{}
    };

    doWebsiteGeneration(requestId,userInputs,user).catch(err=>{
      console.error("Background generation error:",err);
      progressMap[requestId].status='error';
      progressMap[requestId].progress=100;
      // Refund
      User.findOneAndUpdate({walletAddress},{$inc:{credits:1}})
      .catch(refundErr=>console.error("Failed to refund credit:",refundErr));
    });

    return res.json({requestId});
  } catch(err){
    console.error("Error starting generation:",err);
    return res.status(500).json({error:"Internal server error."});
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
  const {status,code,images}= progressMap[requestId];
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
  return res.json({code:finalCode});
});

/**************************************************
 * GET /export?requestId=XYZ&type=full|wordpress
 **************************************************/
app.get('/export',(req,res)=>{
  const {requestId,type}= req.query;
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
    const wpTemplate=`<?php
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
  const {username,password}= req.body;
  if(!username||!password){
    return res.status(400).json({success:false,error:"Username and password are required."});
  }
  try{
    const existingUser=await User.findOne({username});
    if(existingUser){
      return res.status(400).json({success:false,error:"Username already exists. Please choose another one."});
    }
    const walletData=await createWallet();
    if(!walletData.success){
      return res.status(500).json({success:false,error:"Wallet creation failed."});
    }
    const {receivingAddress,xPrv,mnemonic}=walletData;
    const saltRounds=10;
    const passwordHash=await bcrypt.hash(password,saltRounds);

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
    if(err.code===11000&&err.keyPattern&&err.keyPattern.username){
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
    const user=await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({success:false,error:"Invalid wallet address or password."});
    }
    const match=await bcrypt.compare(password,user.passwordHash);
    if(!match){
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
  const {walletAddress}=req.body;
  if(!walletAddress){
    return res.status(400).json({success:false,error:"Missing walletAddress"});
  }
  try{
    await fetchAndProcessUserDeposits(walletAddress);
    const user=await User.findOne({walletAddress});
    if(!user){
      return res.status(404).json({success:false,error:"User not found"});
    }
    return res.json({success:true, credits:user.credits});
  }catch(err){
    console.error("Error scanning deposits on demand:",err);
    return res.status(500).json({success:false,error:"Failed to scan deposits"});
  }
});

/**************************************************
 * POST /save-generated-file
 **************************************************/
app.post('/save-generated-file', async(req,res)=>{
  const {walletAddress,requestId,content}= req.body;
  if(!walletAddress||!requestId||!content){
    return res.status(400).json({success:false,error:"All fields are required."});
  }
  try{
    const user=await User.findOne({walletAddress});
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
    const user=await User.findOne({walletAddress}).lean();
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
      // flush chunk
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
 **************************************************/
async function doWebsiteGeneration(requestId, userInputs, user){
  try{
    const { coinName, colorPalette, projectType, themeSelection, projectDesc } = userInputs || {};
    progressMap[requestId].progress = 10;

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
      background-size:200% 200%;
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

    let systemPrompt=`
    You are a website building ai for my app. Create a full finished beautiful site each time and Generate the single HTML file with EXACT comment markers for each section: 
<!-- SECTION: nav -->, <!-- END: NAV --> .  and the file must be like this <!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
{css}
  </style>
</head>
<body>
{html}
</body>
</html> its integral for my app to work. Make sure to properly layout sites. heading then under it subheading. that type of normal human center vertical layout but give a grid layout to components like cards. The best in the business. utilizing modern styling and css animations. gradients. glass cards.
- Use a gradient of "${colorPalette}" plus the a "${themeSelection}" theme for the color scheming of the background and give an opposite contrast for the components. all sections backgrounds should have a "${themeSelection}" gradient theming following our colors.  keep a consistent theming across the site, gradient and nice looks. 
- Think of the cleanest best websites like apple and others. thats how we need it, not some old 2018 structure.
- Make all sections fully responsive with strong spacing, advanced transitions, glassmorphism, gradient text, etc. Advanced CSS, fade in animations hover animations etc.
- For all the sections except nav and footer, first a heading then under it a subheading, then under that the content. stop putting the heading next to the subheading or the subheading next to the content. it has to be stacked like a normal website.
- Separate sections in this order a nice css js flow between all sections with fade in and those type of anims:
- Buttons are placeholders only. Not clickable.
- Every element must be thought to match/contrast with the other elements and make sure there is a nice flow. 
- No leftover code fences just the raw output as i will insert to an iframe, no text just code.

Use snippet below for partial inspiration (no code fences):
${snippetInspiration}
    `;

    // If NFT or token, add more specifics
    if(projectType.toLowerCase() === 'nft'){
      systemPrompt += `
the file must be like this <!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
{css}
  </style>
</head>
<body>
{html}
</body>
</html>
     You are a website building ai now building a site for the crypto nft project "${coinName}". here is a quick description of the project "${projectDesc}" Generate the single HTML file with EXACT comment markers for each section:
     <!-- SECTION: nav -->, <!-- END: NAV --> .The best in the business. making an nft website. utilizing modern styling and css animations. gradients. glass cards. "${colorPalette}" is the color palette for tones. and a "${themeSelection}" theme for the site
      make sure to have all these sections.
      1) Modern Looking glass Nav (non-sticky) with a 256x256 transparent token logo fit to a nice size => "NAV_IMAGE_PLACEHOLDER" on the left side and on the right side some placeholder nav links that don't work. make sure the image and links are on the same horizontal block and on the left and right like requested. advanced and creative CSS and js (Also repeated in footer as "FOOTER_IMAGE_PLACEHOLDER", same image). 
        2) Modern Big glass hero with a image named (i will replace it) "HERO_BG_PLACEHOLDER" (1024x1024).proper spacing for the heading and subheading. its our splash page. center text. nicely sized cards Must show coin name "${coinName}" and reference "${projectDesc}". advanced and creative CSS and js Space them nicely though.
      3) A heading and under it a subheading component and then under it a Vertical roadmap (5 glass steps).nicely sized cards Fancy. advanced and creative CSS and js Make sure their width is fitting to the screen size.
      4) A heading and under it a subheading component and then under it a NFT distribution section with 3 fancy gradient/glass cards.advanced and creative CSS and js nicely sized cards Under the heading, not next to. Laid out horizontally on computer taking up a whole row of the screen or on mobile vertically laid out.
      5) A heading and under it a subheading component and then under it Exchange/analytics with 6 glass placeholders (laid out nicely).advanced and creative CSS and js nicely sized cards. Under the heading. 2 rows, 3 columns on computer that take up wide enough not so skinny it only takes up one part we need the whole section of the screen and, vertical layout for mobile. Under the heading.
      6) A heading and under it a subheading component and then under it a collection section with 8 placeholder cards for example nfts. Beatiful looks nicely sized cards, advanced and creative CSS and js
      7) glass Footer section at the bottom not sticky. Uses FOOTER_IMAGE_PLACEHOLDER on the left fit to a nice size and on the right it uses placeholder social links that don't work. fake unclickable buttons.
    - Buttons are placeholders only. Not clickable.
    - Every element must be thought to match/contrast with the other elements and make sure there is a nice flow. 
    - No leftover code fences just the raw output as i will insert to an iframe, no text just code.
       `;
    } else {
      systemPrompt += `
You are a website building ai now building a site for the crypto token "${coinName}".here is a quick description of the project "${projectDesc}" Generate the single HTML file with EXACT comment markers for each section: 
        <!-- SECTION: nav -->, <!-- END: NAV --> .The best in the business. making an memecoin website. utilizing modern styling and css animations. gradients. glass cards. "${colorPalette}" is the color pallete for tones. and a "${themeSelection}" theme for the site
         make sure to have all these sections. with all of the requested features. we need everything.
         1) Modern Looking glass Nav (non-sticky) with a 256x256 transparent token logo fit to a nice size => "NAV_IMAGE_PLACEHOLDER" on the left side and on the right side some placeholder nav links that don't work. make sure the image and links are on the same horizontal block and on the left and right like requested. advanced and creative CSS and js (Also repeated in footer as "FOOTER_IMAGE_PLACEHOLDER", same image). 
        2) Modern Big glass hero with a image named (i will replace it) "HERO_BG_PLACEHOLDER" (1024x1024).proper spacing for the heading and subheading. its our splash page. center text. nicely sized cards Must show coin name "${coinName}" and reference "${projectDesc}". advanced and creative CSS and js Space them nicely though.
        3) A heading and under it a subheading component and then under it a Vertical roadmap (5 glass steps).nicely sized cards Fancy. advanced and creative CSS and js Make sure their width is fitting to the screen size.
        4) A heading and under it a subheading component and then under it Tokenomics with 3 fancy gradient/glass cards.advanced and creative CSS and js nicely sized cards Under the heading, not next to. Laid out horizontally on computer taking up a whole row of the screen or on mobile vertically laid out.
        5) A heading and under it a subheading component and then under it Exchange/analytics with 6 glass placeholders (laid out nicely).advanced and creative CSS and js nicely sized cards. Under the heading. 2 rows, 3 columns on computer that take up wide enough not so skinny it only takes up one part we need the whole section of the screen and, vertical layout for mobile. Under the heading.
        6) A heading and under it a subheading component and then under it 2 glass-card about section. Beatiful looks nicely sized cards, advanced and creative CSS and js
        7) glass Footer section at the bottom not sticky. Uses FOOTER_IMAGE_PLACEHOLDER on the left fit to a nice size and on the right it uses placeholder social links that don't work. fake unclickable buttons.
        no leftover code fences. fake buttons.
         - Buttons are placeholders only. Not clickable.
        - Every element must be thought to match/contrast with the other elements and make sure there is a nice flow. 
        - No leftover code fences just the raw output as i will insert to an iframe, no text just code.
      `;
    }

    progressMap[requestId].progress = 20;

    // TEXT GENERATION via GPT
    let gptResponse;
    try {
      gptResponse = await openAiText.createChatCompletion({
        model: "gpt-4o-mini",  
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `
Generate the single HTML file with EXACT sections (nav, hero, etc.). 
for grapejs put the code in <!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
{css}
  </style>
</head>
<body>
{html}
</body> as an example plus the correct comment markers for each section example <!-- SECTION: nav -->, <!-- END: NAV --> . 
No leftover code blocks or markdown fences. 
Ensure it is fully responsive. 
All advanced animations, glass styling, etc. 
make sure its formatted for GrapesJS.
`
          }
        ],
        temperature: 0.7,
        max_tokens: 5000
      });
    } catch (err) {
      if (err.response && err.response.status === 429) {
        console.error("OpenAI rate limit error in doWebsiteGeneration:", err.response.data);
        progressMap[requestId].status='error';
        progressMap[requestId].progress=100;
        return;
      }
      throw err;
    }

    let siteCode = gptResponse.data.choices[0].message.content.trim();
    progressMap[requestId].progress = 60;

    // remove leftover code fences
    siteCode = siteCode.replace(/```+/g,"");

    // Save final code
    progressMap[requestId].code = siteCode;
    progressMap[requestId].status='done';
    progressMap[requestId].progress=100;

    // Save to DB
    user.generatedFiles.push({
      requestId,
      content: siteCode,
      generatedAt: new Date()
    });
    await user.save();

  } catch(error){
    console.error("Error in background generation:", error);
    progressMap[requestId].status='error';
    progressMap[requestId].progress=100;
  }
}

/**************************************************
 * POST /generate-section => refresh single section
 * (Removes partial image generation)
 **************************************************/
app.post('/generate-section', async(req,res)=>{
  const {walletAddress, section, coinName, colorPalette, projectType, themeSelection, projectDesc}=req.body;
  if(!walletAddress||!section){
    return res.status(400).json({error:"Missing walletAddress or section."});
  }
  try{
    const user=await User.findOne({walletAddress});
    if(!user){
      return res.status(400).json({error:"Invalid wallet address."});
    }
    if(user.credits<0.25){
      return res.status(400).json({error:"Insufficient credits (need 0.25)."});
    }
    // Deduct .25
    user.credits-=0.25;
    await user.save();

    let systemPrompt = `
Generate ONLY the [${section}] snippet for a ${projectType} site named "${coinName}". 
 Generate the single HTML file with EXACT comment markers for each section: 
<!-- SECTION: nav -->, <!-- END: NAV --> .  and the file must be like this <!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
{css}
  </style>
</head>
<body>
{html}
</body>
</html> its integral for my app to work. Make sure to properly layout sites. heading then under it subheading. that type of normal human center vertical layout but give a grid layout to components like cards. The best in the business. utilizing modern styling and css animations. gradients. glass cards.
- Use a gradient of "${colorPalette}" plus the a "${themeSelection}" theme for the color scheming of the background and give an opposite contrast for the components. all sections backgrounds should have a "${themeSelection}" gradient theming following our colors.  keep a consistent theming across the site, gradient and nice looks. 
- Think of the cleanest best websites like apple and others. thats how we need it, not some old 2018 structure.
- Make all sections fully responsive with strong spacing, advanced transitions, glassmorphism, gradient text, etc. Advanced CSS, fade in animations hover animations etc.
- For all the sections except nav and footer, first a heading then under it a subheading, then under that the content. stop putting the heading next to the subheading or the subheading next to the content. it has to be stacked like a normal website.
- Separate sections in this order a nice css js flow between all sections with fade in and those type of anims:
- Buttons are placeholders only. Not clickable.
- Every element must be thought to match/contrast with the other elements and make sure there is a nice flow. 
- No leftover code fences just the raw output as i will insert to an iframe, no text just code.

Use snippet below for partial inspiration (no code fences):
`;

    const gptResp = await openAiText.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        {role:"system", content:systemPrompt},
        {
          role:"user",
          content:`Generate ONLY that [${section}] snippet with markers. For example: 
<!DOCTYPE html><html><head>...<body>... plus the correct comment markers. 
No leftover code fences. 
Fully responsive.`
        }
      ],
      max_tokens:2000,
      temperature:0.7
    });

    let snippet= gptResp.data.choices[0].message.content.trim();
    snippet= snippet.replace(/```+/g,"");

    return res.json({
      snippet,
      images:{}, // no images generated
      newCredits: user.credits
    });
  } catch(err){
    console.error("Error in /generate-section:", err);
    return res.status(500).json({error:"Internal server error."});
  }
});

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
  console.error("Unhandled Error:", err.stack);
  res.status(500).json({error:"Something went wrong!"});
});

/**************************************************
 * Launch
 **************************************************/
const PORT=process.env.PORT||5000;
app.listen(PORT,()=>{
  console.log(`KasperCoin Website Builder API running on port ${PORT}!`);
});
