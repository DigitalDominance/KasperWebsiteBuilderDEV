// backend/models/User.js

const mongoose = require('mongoose');

// Track any website generation
const GeneratedFileSchema = new mongoose.Schema({
  requestId: { type: String, required: true },
  content: { type: String, required: true },
  generatedAt: { type: Date, default: Date.now }
});
// Track processed deposit transactions (KAS/KASPER)
const ProcessedTransactionSchema = new mongoose.Schema({
  txid: { type: String, required: true },  // e.g. the KAS or KASPER TX hash
  coinType: { type: String },              // e.g. 'KAS' or 'KASPER'
  amount: { type: Number, default: 0 },    // how many KAS or KASPER
  creditsAdded: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
  username:       { type: String, required: true, unique: true },
  walletAddress:  { type: String, required: true, unique: true },
  passwordHash:   { type: String, required: true },
  xPrv:           { type: String, required: true },
  mnemonic:       { type: String, required: true },
  credits:        { type: Number, default: 0 },
  generatedFiles: [GeneratedFileSchema],
  
  // NEW: Array of processed deposit TXs
  processedTransactions: {
    type: [ProcessedTransactionSchema],
    default: []
  },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
