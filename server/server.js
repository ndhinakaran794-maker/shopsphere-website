require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cron = require('node-cron');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000/api';
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../')));

// -------------------------------------------------------------
// 1. Database Connection
// -------------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/shopsphere';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected successfully.'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// -------------------------------------------------------------
// 2. Database Models
// -------------------------------------------------------------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  optedInMarketing: { type: Boolean, default: false },
  subscriptionTier: { type: String, enum: ['normal', 'premium'], default: 'normal' },
  subscriptionExpiresAt: { type: Date, default: null }
}, { timestamps: true });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
  category: { type: String, default: 'General' },
  imageUrl: String,
  stock: { type: Number, default: 5 }
}, { timestamps: true });

const cartItemSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  cartId: { type: String, required: true, unique: true },
  productId: { type: String, required: true },
  name: { type: String, required: true },
  category: { type: String, default: 'General' },
  price: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Feature 4: Order schema updated to capture UTM attribution parameters
const orderSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  orderId: { type: String, required: true, unique: true },
  productName: { type: String, required: true },
  pricePaid: { type: Number, required: true },
  shippingSpeed: { type: String, required: true },
  tierUsed: { type: String, required: true },
  promoApplied: { type: String, default: null },
  attribution: {
    utm_source: String,
    utm_medium: String,
    utm_campaign: String,
    utm_term: String,
    utm_content: String
  },
  date: { type: Date, default: Date.now }
}, { timestamps: true });

// Feature 6: Review trigger scheduling schema
const reviewScheduleSchema = new mongoose.Schema({
  orderId: { type: String, required: true },
  customerEmail: { type: String, required: true },
  productName: { type: String, required: true },
  status: { type: String, enum: ['PENDING_DELIVERY', 'SENT'], default: 'PENDING_DELIVERY' },
  scheduledTriggerDate: { type: Date, required: true }
}, { timestamps: true });

// Feature 1: Abandoned Cart Log Schema
const abandonedCartLogSchema = new mongoose.Schema({
  userEmail: { type: String, default: 'guest' },
  cartItemCount: { type: Number, required: true },
  cartTotal: { type: Number, required: true },
  items: [String],
  abandonedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Product = mongoose.model('Product', productSchema);
const CartItem = mongoose.model('CartItem', cartItemSchema);
const Order = mongoose.model('Order', orderSchema);
const ReviewSchedule = mongoose.model('ReviewSchedule', reviewScheduleSchema);
const AbandonedCartLog = mongoose.model('AbandonedCartLog', abandonedCartLogSchema);

// Promo Code Definitions (Feature 3)
const PROMO_CODES = {
  'WELCOME10': { type: 'PERCENT', value: 0.10, desc: '10% OFF' },
  'SAVE20': { type: 'FIXED', value: 20.00, desc: '$20 OFF' }
};

// -------------------------------------------------------------
// FEATURE 2: Webhook Dispatcher Helper Engine
// -------------------------------------------------------------
async function dispatchServerWebhook(eventName, payload) {
  // Check marketing consent for promotional/marketing-related events
  const promotionalEvents = [
    'ABANDONED_CART_DETECTED',
    'POST_PURCHASE_REVIEW_SCHEDULED',
    'POST_PURCHASE_REVIEW_DISPATCHED',
    'VIP_TIER_EXPIRING'
  ];

  if (promotionalEvents.includes(eventName)) {
    const userEmail = payload.userEmail || payload.customerEmail || payload.email || (payload.data && payload.data.userEmail);
    if (userEmail && userEmail !== 'guest') {
      const user = await User.findOne({ email: String(userEmail).toLowerCase() });
      if (user && !user.optedInMarketing) {
        console.log(`[Server Webhook Notice] Skipping promotional event ${eventName} for ${userEmail}: User has not opted in to marketing.`);
        return;
      }
    }
  }

  const eventData = {
    event: eventName,
    timestamp: new Date().toISOString(),
    source: 'SHOP_SPHERE_BACKEND',
    data: payload
  };

  console.log(`[Server Webhook Dispatcher] -> Event: ${eventName}`, eventData);

  // Example integration forwarder to external Webhook/ESPs (Klaviyo/SendGrid)
  const webhookUrl = process.env.EXTERNAL_WEBHOOK_URL;
  if (webhookUrl && webhookUrl.trim() !== '') {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData)
      });
    } catch (err) {
      console.warn(`[Server Webhook] Delivery failed for ${eventName}:`, err.message);
    }
  } else {
    console.info(`[Server Webhook Notice] EXTERNAL_WEBHOOK_URL is not set or empty. Skipping external POST dispatch for ${eventName}.`);
  }
}

// -------------------------------------------------------------
// REVIEW SCHEDULER CRON WORKER
// -------------------------------------------------------------
cron.schedule('* * * * *', async () => {
  try {
    const dueReviews = await ReviewSchedule.find({
      status: 'PENDING_DELIVERY',
      scheduledTriggerDate: { $lte: new Date() }
    });

    for (const review of dueReviews) {
      await dispatchServerWebhook('POST_PURCHASE_REVIEW_DISPATCHED', review);
      review.status = 'SENT';
      await review.save();
      console.log(`[Review Cron] Successfully processed review trigger for Order: ${review.orderId}`);
    }
  } catch (error) {
    console.error('[Review Cron Error]:', error.message);
  }
});

// -------------------------------------------------------------
// 3. API Routes
// -------------------------------------------------------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend running smoothly.' });
});

// FEATURE 2: Event Webhook Dispatcher Route
app.post('/api/webhooks/events', async (req, res) => {
  try {
    const { event, data, user } = req.body;
    console.log(`📥 Received Webhook Event [${event}]:`, data);

    await dispatchServerWebhook(event, { user, ...data });

    res.status(200).json({ status: 'SUCCESS', message: `Webhook event ${event} processed.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 1: Abandoned Cart Event Logger Route
app.post('/api/events/abandoned-cart', async (req, res) => {
  try {
    const { userEmail, cartItemCount, cartTotal, items } = req.body;

    const log = new AbandonedCartLog({
      userEmail: userEmail || 'guest',
      cartItemCount: cartItemCount || 0,
      cartTotal: cartTotal || 0,
      items: items || []
    });

    await log.save();
    await dispatchServerWebhook('ABANDONED_CART_DETECTED', log);

    res.status(201).json({ status: 'LOGGED', log });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 5: Dynamic Custom User Metadata Aggregator Route
app.get('/api/user/profile-metadata/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const orders = await Order.find({ userEmail: email }).sort({ date: -1 });
    
    const profileMetadata = {
      email: user.email,
      name: user.name,
      membership_tier: user.subscriptionTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      total_orders_count: orders.length,
      last_purchase_date: orders.length > 0 ? orders[0].date : null,
      optedInMarketing: user.optedInMarketing
    };

    res.json(profileMetadata);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/dispatch-metadata', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const orders = await Order.find({ userEmail: email.toLowerCase() }).sort({ date: -1 });
    
    const profileMetadata = {
      email: user.email,
      membership_tier: user.subscriptionTier,
      total_orders_count: orders.length,
      last_purchase_date: orders.length > 0 ? orders[0].date : null,
      optedInMarketing: user.optedInMarketing
    };

    await dispatchServerWebhook('USER_PROFILE_UPDATED', profileMetadata);
    res.json({ status: 'SUCCESS', metadata: profileMetadata });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User Preferences Endpoint (Update optedInMarketing)
app.patch('/api/user/preferences', async (req, res) => {
  try {
    const { email, optedInMarketing } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'User email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (optedInMarketing !== undefined) {
      user.optedInMarketing = Boolean(optedInMarketing);
      await user.save();
    }

    await dispatchServerWebhook('USER_PREFERENCES_UPDATED', {
      email: user.email,
      optedInMarketing: user.optedInMarketing
    });

    res.json({
      message: 'User preferences updated successfully!',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        optedInMarketing: user.optedInMarketing,
        subscriptionTier: user.subscriptionTier,
        subscriptionExpiresAt: user.subscriptionExpiresAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 6: Post-Purchase Review Request Scheduler Routes
app.post('/api/orders/schedule-review', async (req, res) => {
  try {
    const { orderId, customerEmail, productName, scheduledTriggerDate } = req.body;

    const reviewSchedule = new ReviewSchedule({
      orderId,
      customerEmail,
      productName,
      scheduledTriggerDate: scheduledTriggerDate ? new Date(scheduledTriggerDate) : new Date(Date.now() + (3 * 24 * 60 * 60 * 1000))
    });

    await reviewSchedule.save();
    await dispatchServerWebhook('POST_PURCHASE_REVIEW_SCHEDULED', reviewSchedule);

    res.status(201).json({ status: 'SCHEDULED', reviewSchedule });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/pending-reviews', async (req, res) => {
  try {
    const pending = await ReviewSchedule.find({ status: 'PENDING_DELIVERY' });
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 7: VIP Tier Expiration & Threshold Listener Route
app.get('/api/user/check-vip-status/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.subscriptionTier === 'premium' && user.subscriptionExpiresAt) {
      const now = new Date();
      const expiry = new Date(user.subscriptionExpiresAt);
      const diffMs = expiry.getTime() - now.getTime();
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

      if (diffMs <= 0) {
        user.subscriptionTier = 'normal';
        user.subscriptionExpiresAt = null;
        await user.save();
        await dispatchServerWebhook('VIP_TIER_EXPIRED', { email: user.email });

        return res.json({ status: 'EXPIRED', membership_tier: 'normal' });
      } else if (diffMs <= THREE_DAYS_MS) {
        const daysLeft = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        await dispatchServerWebhook('VIP_TIER_EXPIRING', { email: user.email, daysRemaining: daysLeft });

        return res.json({ status: 'EXPIRING_SOON', daysRemaining: daysLeft, membership_tier: 'premium' });
      }
    }

    res.json({ status: 'ACTIVE', membership_tier: user.subscriptionTier });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Seed Sample Products Route (Updated with complete catalog of 50 items)
app.get('/api/seed-products', async (req, res) => {
  try {
    await Product.deleteMany({});

    const sampleProducts = [
      // 1. Fashion & Apparel
      { name: "Classic Slim-Fit Cotton T-Shirt", category: "Men's Clothing", price: 24.99, stock: 10, description: "Comfortable slim-fit cotton T-shirt.", imageUrl: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=500&q=70" },
      { name: "Water-Resistant Windbreaker Jacket", category: "Men's Clothing", price: 69.99, stock: 8, description: "Lightweight and weather-proof windbreaker jacket.", imageUrl: "https://images.unsplash.com/photo-1548883354-7622d03aca27?w=500&q=70" },
      { name: "Floral Print Summer Maxi Dress", category: "Women's Clothing", price: 49.99, stock: 12, description: "Elegant floral print maxi dress ideal for summer.", imageUrl: "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?w=500&q=70" },
      { name: "High-Waisted Seamless Leggings", category: "Women's Clothing", price: 34.99, stock: 15, description: "Stretchable and breathable high-waisted active leggings.", imageUrl: "https://images.unsplash.com/photo-1506629082925-2368c7f84cf1?w=500&q=70" },
      { name: "Breathable Athletic Running Shorts", category: "Activewear", price: 29.99, stock: 10, description: "Lightweight sports shorts with quick-dry fabric.", imageUrl: "https://images.unsplash.com/photo-1591195853828-11db59a44f6b?w=500&q=70" },
      { name: "Low-Top Canvas Sneakers", category: "Footwear", price: 44.99, stock: 10, description: "Classic low-top canvas sneakers for casual daily wear.", imageUrl: "https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?w=500&q=70" },
      { name: "Leather Oxford Dress Shoes", category: "Footwear", price: 89.99, stock: 6, description: "Premium genuine leather formal oxford shoes.", imageUrl: "https://images.unsplash.com/photo-1614252235316-8c857d38b5f4?w=500&q=70" },
      { name: "Genuine Leather Bi-Fold Wallet", category: "Accessories", price: 29.99, stock: 20, description: "Compact leather wallet with multiple card slots.", imageUrl: "https://images.unsplash.com/photo-1627123424574-724758594e93?w=500&q=70" },
      { name: "UV-400 Polarized Aviator Sunglasses", category: "Accessories", price: 39.99, stock: 14, description: "Classic metal frame aviator sunglasses with UV protection.", imageUrl: "https://images.unsplash.com/photo-1511499767150-a48a237f0083?w=500&q=70" },
      { name: "Waterproof Canvas Laptop Backpack", category: "Accessories", price: 59.99, stock: 9, description: "Durable canvas laptop backpack with multiple compartments.", imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=500&q=70" },

      // 2. Electronics & Accessories
      { name: "4K Ultra-HD Vlog Camera", category: "Electronics", price: 399.99, stock: 5, description: "Compact 4K vlogging camera with flip screen.", imageUrl: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=500&q=70" },
      { name: "Active Noise-Canceling Wireless Headphones", category: "Personal Audio", price: 149.99, stock: 8, description: "Over-ear Bluetooth headphones with active noise cancellation.", imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500&q=70" },
      { name: "Hard-Shell Headphone Travel Case", category: "Tech Accessories", price: 19.99, stock: 15, description: "Protective travel case for over-ear headphones.", imageUrl: "https://images.unsplash.com/photo-1583394838336-acd977736f90?w=500&q=70" },
      { name: "Portable Waterproof Bluetooth Speaker", category: "Personal Audio", price: 49.99, stock: 12, description: "Rugged waterproof outdoor wireless speaker.", imageUrl: "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=500&q=70" },
      { name: "Magnetic 3-in-1 Wireless Charging Station", category: "Mobile Accessories", price: 39.99, stock: 10, description: "Fast wireless charging dock for phone, watch, and earbuds.", imageUrl: "https://images.unsplash.com/photo-1622445268465-843d31d78c68?w=500&q=70" },
      { name: "Ultra-Slim 20,000mAh Power Bank", category: "Mobile Accessories", price: 34.99, stock: 15, description: "High-capacity portable battery pack with fast charging.", imageUrl: "https://images.unsplash.com/photo-1609592424074-8d486016e3c6?w=500&q=70" },
      { name: "Shockproof Matte Phone Case", category: "Mobile Accessories", price: 14.99, stock: 25, description: "Slim shock-absorbing protective phone cover.", imageUrl: "https://images.unsplash.com/photo-1580910051074-3eb694886505?w=500&q=70" },
      { name: "Fitness Tracker with Heart Rate Monitor", category: "Wearables", price: 59.99, stock: 11, description: "Smart fitness band tracking steps, sleep, and heart rate.", imageUrl: "https://images.unsplash.com/photo-1575311373937-040b8e1fd5b6?w=500&q=70" },
      { name: "RGB Smart LED Ambient Light Bar", category: "Smart Home", price: 44.99, stock: 7, description: "Customizable ambient LED light bars for setup illumination.", imageUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=500&q=70" },
      { name: "Microfiber Camera Lens & Sensor Cleaner Kit", category: "Electronics Accessories", price: 12.99, stock: 20, description: "Complete cleaning kit for digital camera lenses and optics.", imageUrl: "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=500&q=70" },

      // 3. Beauty & Personal Care
      { name: "Electric Precision Beard Trimmer", category: "Grooming", price: 39.99, stock: 10, description: "Rechargeable precision beard and hair trimmer.", imageUrl: "https://images.unsplash.com/photo-1621607512214-68297480165e?w=500&q=70" },
      { name: "Organic Beard Oil & Balm Set", category: "Grooming", price: 24.99, stock: 14, description: "Nourishing natural beard conditioning oil and balm.", imageUrl: "https://images.unsplash.com/photo-1608248597261-5421778b1628?w=500&q=70" },
      { name: "Hydrating Hyaluronic Acid Facial Serum", category: "Skincare", price: 22.99, stock: 18, description: "Deeply moisturizing serum for plumper skin texture.", imageUrl: "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=500&q=70" },
      { name: "Gentle Foaming Daily Facial Cleanser", category: "Skincare", price: 16.99, stock: 20, description: "Soothing face cleanser suitable for daily use.", imageUrl: "https://images.unsplash.com/photo-1556228720-195a672e8a03?w=500&q=70" },
      { name: "Broad-Spectrum SPF 50 Mineral Sunscreen", category: "Skincare", price: 19.99, stock: 16, description: "Non-greasy broad spectrum sun protection lotion.", imageUrl: "https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?w=500&q=70" },
      { name: "Sulfate-Free Argan Oil Shampoo", category: "Haircare", price: 18.99, stock: 12, description: "Gentle restoring shampoo enriched with organic argan oil.", imageUrl: "https://images.unsplash.com/photo-1535585209827-a15fcdbc4c2d?w=500&q=70" },
      { name: "Deep Repair Argan Oil Hair Conditioner", category: "Haircare", price: 18.99, stock: 12, description: "Hydrating deep hair conditioner for smooth shine.", imageUrl: "https://images.unsplash.com/photo-1526947425960-945c6e72858f?w=500&q=70" },
      { name: "Matte Long-Wear Liquid Lipstick", category: "Cosmetics", price: 14.99, stock: 22, description: "Vibrant and long-lasting matte liquid lipstick.", imageUrl: "https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=500&q=70" },
      { name: "Exfoliating Charcoal Body Wash", category: "Grooming", price: 12.99, stock: 15, description: "Purifying body wash infused with activated charcoal.", imageUrl: "https://images.unsplash.com/photo-1607006344380-b6775a0824a7?w=500&q=70" },
      { name: "Rechargeable Sonic Electric Toothbrush", category: "Personal Care", price: 49.99, stock: 8, description: "Powerful sonic toothbrush with multiple brushing modes.", imageUrl: "https://images.unsplash.com/photo-1559591937-e68fb3305e40?w=500&q=70" },

      // 4. Home, Kitchen & Living
      { name: "French Press Stainless Steel Coffee Maker", category: "Kitchen", price: 29.99, stock: 10, description: "Classic french press coffee maker with stainless steel mesh.", imageUrl: "https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=500&q=70" },
      { name: "Precision Burr Coffee Bean Grinder", category: "Kitchen", price: 49.99, stock: 7, description: "Adjustable manual burr grinder for precise coffee grinding.", imageUrl: "https://images.unsplash.com/photo-1589396575653-c09c794ff6a6?w=500&q=70" },
      { name: "Hand-Poured Soy Wax Scented Candle", category: "Home Décor", price: 18.99, stock: 15, description: "Aromatic soy wax candle in a stylish glass container.", imageUrl: "https://images.unsplash.com/photo-1603006905003-be475563bc59?w=500&q=70" },
      { name: "Minimalist Ceramic Flower Vase", category: "Home Décor", price: 24.99, stock: 12, description: "Modern aesthetic ceramic vase for floral arrangements.", imageUrl: "https://images.unsplash.com/photo-1578500494198-246f612d3b3d?w=500&q=70" },
      { name: "Framed Abstract Canvas Wall Art", category: "Home Décor", price: 59.99, stock: 5, description: "Contemporary abstract wall art in a sleek wooden frame.", imageUrl: "https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=500&q=70" },
      { name: "Insulated Stainless Steel Travel Tumbler", category: "Kitchen", price: 21.99, stock: 18, description: "Double-wall vacuum insulated mug for hot and cold drinks.", imageUrl: "https://images.unsplash.com/photo-1517256064527-09c73fc73e38?w=500&q=70" },
      { name: "Non-Stick Ceramic Frying Pan", category: "Kitchen", price: 34.99, stock: 9, description: "Eco-friendly non-stick ceramic skillet for easy cooking.", imageUrl: "https://images.unsplash.com/photo-1584992236310-6edddc08acff?w=500&q=70" },
      { name: "100% Egyptian Cotton Sheet Set", category: "Bedding", price: 79.99, stock: 6, description: "Ultra-soft and breathable high thread count cotton sheets.", imageUrl: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=500&q=70" },
      { name: "Ergonomic Memory Foam Bed Pillow", category: "Bedding", price: 39.99, stock: 11, description: "Supportive memory foam pillow designed for neck relief.", imageUrl: "https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?w=500&q=70" },
      { name: "Quick-Dry Plush Bath Towel Set", category: "Bath", price: 32.99, stock: 14, description: "Absorbent cotton bath towels set.", imageUrl: "https://images.unsplash.com/photo-1616627547584-bf28cee262db?w=500&q=70" },

      // 5. Lifestyle, Sports & Fitness
      { name: "Non-Slip Extra-Thick Yoga Mat", category: "Fitness", price: 29.99, stock: 15, description: "Cushioned non-slip workout mat for yoga and exercise.", imageUrl: "https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?w=500&q=70" },
      { name: "Adjustable Cotton Yoga Carrying Strap", category: "Fitness", price: 9.99, stock: 25, description: "Durable cotton strap for carrying and stretching.", imageUrl: "https://images.unsplash.com/photo-1518611012118-696072aa579a?w=500&q=70" },
      { name: "32oz Motivational Time-Marked Water Bottle", category: "Fitness", price: 16.99, stock: 20, description: "BPA-free daily water bottle with hourly intake reminders.", imageUrl: "https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=500&q=70" },
      { name: "Expandable Travel Duffel Bag", category: "Travel", price: 44.99, stock: 8, description: "Versatile weekend travel duffel bag with shoe compartment.", imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=500&q=70" },
      { name: "Genuine Leather Luggage Tags", category: "Travel", price: 11.99, stock: 30, description: "Durable leather privacy baggage identification tags.", imageUrl: "https://images.unsplash.com/photo-1544816155-12df9643f363?w=500&q=70" },
      { name: "Hardcover Grid Bullet Journal Notebook", category: "Stationery", price: 15.99, stock: 18, description: "Thick paper grid notebook for planning and notes.", imageUrl: "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=500&q=70" },
      { name: "Fine-Point Gel Ink Pen Set (12 Pack)", category: "Stationery", price: 12.99, stock: 22, description: "Smooth writing fine-point gel pens for daily journaling.", imageUrl: "https://images.unsplash.com/photo-1585336261026-8f5786372969?w=500&q=70" },
      { name: "Ultralight Compact Camping Hammock", category: "Outdoor", price: 27.99, stock: 10, description: "Portable nylon hammock with tree straps for outdoor camping.", imageUrl: "https://images.unsplash.com/photo-1526772662000-3f88f10405ff?w=500&q=70" },
      { name: "Aluminum Ergonomic Desk Laptop Stand", category: "Desk Accessories", price: 34.99, stock: 12, description: "Elevated aluminum cooling stand for laptops.", imageUrl: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=500&q=70" },
      { name: "Curated Gourmet Tea Gift Set", category: "Gifts", price: 26.99, stock: 10, description: "Assorted premium loose-leaf tea sampler set.", imageUrl: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=500&q=70" }
    ];

    await Product.insertMany(sampleProducts);
    res.json({ message: "Seeded database with 50 updated catalog products!", count: sampleProducts.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register Route (Dispatches USER_REGISTERED Webhook & Returns Auth Token)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, optedInMarketing } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      name: name || email.split('@')[0],
      email: email.toLowerCase(),
      password: hashedPassword,
      optedInMarketing: Boolean(optedInMarketing)
    });

    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret_key', { expiresIn: '1d' });

    await dispatchServerWebhook('USER_REGISTERED', {
      email: user.email,
      name: user.name,
      optedInMarketing: user.optedInMarketing
    });

    res.status(201).json({
      message: 'User registered successfully!',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        optedInMarketing: user.optedInMarketing,
        subscriptionTier: user.subscriptionTier,
        subscriptionExpiresAt: user.subscriptionExpiresAt
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message || 'Server error during registration.' });
  }
});

// Login Route
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Auto-check subscription expiry on login
    if (user.subscriptionTier === 'premium' && user.subscriptionExpiresAt && new Date() > user.subscriptionExpiresAt) {
      user.subscriptionTier = 'normal';
      user.subscriptionExpiresAt = null;
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret_key', { expiresIn: '1d' });
    
    await dispatchServerWebhook('USER_LOGGED_IN', { email: user.email });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        optedInMarketing: user.optedInMarketing,
        subscriptionTier: user.subscriptionTier,
        subscriptionExpiresAt: user.subscriptionExpiresAt
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Server error during login.' });
  }
});

// Fetch Products Route
app.get('/api/products', async (req, res) => {
  try {
    const rawProducts = await Product.find();

    const uniqueMap = new Map();
    rawProducts.forEach((item) => {
      if (!uniqueMap.has(item.name)) {
        uniqueMap.set(item.name, item);
      }
    });

    const uniqueProducts = Array.from(uniqueMap.values());
    res.json(uniqueProducts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reduce Product Stock Route
app.patch('/api/products/:id/stock', async (req, res) => {
  try {
    const { quantity = 1 } = req.body;
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    if (product.stock < quantity) {
      return res.status(400).json({ error: 'Insufficient stock available.' });
    }

    product.stock = Math.max(0, product.stock - quantity);
    await product.save();

    res.json({ message: 'Stock updated successfully.', product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 3: Validate Promo Code Route (Preserved)
app.post('/api/promo/validate', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Promo code is required.' });
  }

  const formattedCode = code.trim().toUpperCase();
  const promo = PROMO_CODES[formattedCode];

  if (!promo) {
    return res.status(404).json({ error: 'Invalid promo code.' });
  }

  res.json({ code: formattedCode, ...promo });
});

// -------------------------------------------------------------
// DATABASE PERSISTENCE ENDPOINTS (CART, ORDERS, SUBSCRIPTION)
// -------------------------------------------------------------

// Fetch User Cart
app.get('/api/cart/:email', async (req, res) => {
  try {
    const cartItems = await CartItem.find({ userEmail: req.params.email.toLowerCase() });
    res.json(cartItems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Item to Cart
app.post('/api/cart', async (req, res) => {
  try {
    const { userEmail, cartId, productId, name, category, price, addedAt } = req.body;
    
    let normalizedProductId = productId ? String(productId) : null;
    if (normalizedProductId && mongoose.Types.ObjectId.isValid(normalizedProductId)) {
      const product = await Product.findById(normalizedProductId);
      if (product && product.stock <= 0) {
        return res.status(400).json({ error: 'Product is currently out of stock.' });
      }
    }

    const cartItem = new CartItem({
      userEmail: userEmail.toLowerCase(),
      cartId: String(cartId),
      productId: normalizedProductId,
      name,
      category,
      price,
      addedAt
    });
    await cartItem.save();

    await dispatchServerWebhook('ADD_TO_CART', { userEmail, productName: name, price });

    res.status(201).json(cartItem);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove Item from Cart
app.delete('/api/cart/:cartId', async (req, res) => {
  try {
    await CartItem.deleteOne({ cartId: req.params.cartId });
    res.json({ message: 'Item removed from cart' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch User Orders
app.get('/api/orders/:email', async (req, res) => {
  try {
    const orders = await Order.find({ userEmail: req.params.email.toLowerCase() }).sort({ date: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// FEATURE 4 & 6: Create New Order (With Attribution, Webhooks & Review Scheduler)
app.post('/api/orders', async (req, res) => {
  try {
    const { userEmail, orderId, productId, productName, pricePaid, shippingSpeed, tierUsed, promoApplied, attribution, date } = req.body;
    
    let normalizedProductId = productId ? String(productId) : null;
    if (normalizedProductId && mongoose.Types.ObjectId.isValid(normalizedProductId)) {
      const product = await Product.findById(normalizedProductId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
      }
      if (product.stock <= 0) {
        return res.status(400).json({ error: 'Product is out of stock and cannot be ordered.' });
      }
      product.stock -= 1;
      await product.save();
    }

    const order = new Order({
      userEmail: userEmail.toLowerCase(),
      orderId,
      productName,
      pricePaid,
      shippingSpeed,
      tierUsed,
      promoApplied: promoApplied || null,
      attribution: attribution || {},
      date
    });
    await order.save();

    // FEATURE 2: Dispatch ORDER_COMPLETED server webhook
    await dispatchServerWebhook('ORDER_COMPLETED', order);

    // FEATURE 6: Automatically schedule post-purchase review event
    const reviewSchedule = new ReviewSchedule({
      orderId: order.orderId,
      customerEmail: order.userEmail,
      productName: order.productName,
      scheduledTriggerDate: new Date(Date.now() + (3 * 24 * 60 * 60 * 1000))
    });
    await reviewSchedule.save();

    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upgrade Subscription (Dispatches TIER_UPGRADED)
app.post('/api/user/subscribe', async (req, res) => {
  try {
    const { email, days = 30 } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);

    user.subscriptionTier = 'premium';
    user.subscriptionExpiresAt = expiryDate;
    await user.save();

    await dispatchServerWebhook('TIER_UPGRADED', {
      email: user.email,
      newTier: 'premium',
      subscriptionExpiresAt: expiryDate
    });

    res.json({
      message: 'Subscription upgraded successfully!',
      subscriptionTier: user.subscriptionTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check/Fetch Subscription Status
app.get('/api/user/subscription/:email', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.subscriptionTier === 'premium' && user.subscriptionExpiresAt && new Date() > user.subscriptionExpiresAt) {
      user.subscriptionTier = 'normal';
      user.subscriptionExpiresAt = null;
      await user.save();
    }

    res.json({
      subscriptionTier: user.subscriptionTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback to Serve Frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});