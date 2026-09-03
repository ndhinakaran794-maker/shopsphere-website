// -------------------------------------------------------------
// Global Application State & Storage Keys
// -------------------------------------------------------------
const API_BASE_URL = 'http://localhost:5000/api';

let products = [];
let cart = [];
let orders = [];
let currentUser = null;
let appliedPromo = null;
let pendingCheckoutProduct = null;
let timerInterval = null;
let utmParams = {};
let vipWarningTriggered = false;

const USER_STORAGE_KEY = 'shopsphere_logged_user';
const UTM_STORAGE_KEY = 'shopsphere_utm_params';
const WEBHOOK_QUEUE_KEY = 'shopsphere_failed_webhooks';

// Promo Code Definitions
const PROMO_CODES = {
  'WELCOME10': { type: 'PERCENT', value: 0.10, desc: '10% OFF' },
  'SAVE20': { type: 'FIXED', value: 20.00, desc: '$20 OFF' },
  'SAVE15': { type: 'PERCENT', value: 0.15, desc: '15% OFF' }
};

// Dynamic storage key generators based on user session
function getCartStorageKey() {
  return currentUser ? `shopsphere_cart_${currentUser.email}` : 'shopsphere_cart_guest';
}

function getOrdersStorageKey() {
  return currentUser ? `shopsphere_orders_${currentUser.email}` : 'shopsphere_orders_guest';
}

function getTierStorageKey() {
  return currentUser ? `shopsphere_tier_${currentUser.email}` : 'shopsphere_tier_guest';
}

function getExpiryStorageKey() {
  return currentUser ? `shopsphere_expiry_${currentUser.email}` : 'shopsphere_expiry_guest';
}

// Track rendered states to eliminate redundant DOM redraws
let lastRenderedCartLength = -1;
let lastRenderedOrdersLength = -1;

// -------------------------------------------------------------
// 1. App Initialization & Event Listeners
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', initApp);

function initApp() {
  extractUTMParameters();
  loadStoredData();
  checkTierExpiration();
  updateUI();
  fetchProducts();
  startCartTimers();

  // Process any pending offline webhook retries when coming online
  window.addEventListener('online', processWebhookQueue);
  processWebhookQueue();

  // Feature 1: Register window unload & visibility listeners for Abandoned Cart event logging
  window.addEventListener('beforeunload', handleAbandonedCartCheck);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      handleAbandonedCartCheck();
    }
  });

  // Periodically check for subscription expiration every minute
  setInterval(checkTierExpiration, 60000);
}

function loadStoredData() {
  try {
    const savedUser = localStorage.getItem(USER_STORAGE_KEY);
    currentUser = savedUser ? JSON.parse(savedUser) : null;

    const savedCart = localStorage.getItem(getCartStorageKey());
    cart = savedCart ? JSON.parse(savedCart) : [];

    const savedOrders = localStorage.getItem(getOrdersStorageKey());
    orders = savedOrders ? JSON.parse(savedOrders) : [];
  } catch (e) {
    console.error('Failed to parse local storage data', e);
    cart = [];
    orders = [];
    currentUser = null;
  }
}

// -------------------------------------------------------------
// Feature 2: Event Payload API Webhook Dispatcher & Retry Queue
// -------------------------------------------------------------
async function dispatchWebhookEvent(eventName, payload) {
  const eventData = {
    event: eventName,
    timestamp: new Date().toISOString(),
    user: currentUser ? { email: currentUser.email, name: currentUser.name } : 'guest',
    data: payload
  };

  console.log(`[Webhook Engine] Dispatching Event: ${eventName}`, eventData);

  // Append to on-screen console modal if present
  const consoleEl = document.getElementById('eventLoggerConsole');
  if (consoleEl) {
    consoleEl.textContent = `[${new Date().toLocaleTimeString()}] DISPATCH -> ${eventName}\n` + JSON.stringify(eventData, null, 2) + '\n\n' + consoleEl.textContent;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/webhooks/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`Webhook endpoint offline or failed. Payload queued locally: ${eventName}`, eventData);
    queueWebhookPayload(eventData);
  }
}

function queueWebhookPayload(eventData) {
  try {
    const queuedEvents = JSON.parse(localStorage.getItem(WEBHOOK_QUEUE_KEY) || '[]');
    queuedEvents.push(eventData);
    localStorage.setItem(WEBHOOK_QUEUE_KEY, JSON.stringify(queuedEvents));
  } catch (e) {
    console.error('Failed to save webhook payload to queue in localStorage', e);
  }
}

async function processWebhookQueue() {
  if (!navigator.onLine) return;

  try {
    const queuedEvents = JSON.parse(localStorage.getItem(WEBHOOK_QUEUE_KEY) || '[]');
    if (queuedEvents.length === 0) return;

    console.log(`[Webhook Engine] Retrying ${queuedEvents.length} queued events...`);
    const remainingEvents = [];

    for (const eventData of queuedEvents) {
      try {
        const response = await fetch(`${API_BASE_URL}/webhooks/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData)
        });

        if (!response.ok) {
          remainingEvents.push(eventData);
        }
      } catch (err) {
        remainingEvents.push(eventData);
      }
    }

    if (remainingEvents.length === 0) {
      localStorage.removeItem(WEBHOOK_QUEUE_KEY);
      console.log('[Webhook Engine] All queued events successfully dispatched.');
    } else {
      localStorage.setItem(WEBHOOK_QUEUE_KEY, JSON.stringify(remainingEvents));
    }
  } catch (e) {
    console.error('Failed to process webhook queue', e);
  }
}

// -------------------------------------------------------------
// Feature 4: UTM Parameter Reader (Attribution Engine)
// -------------------------------------------------------------
function extractUTMParameters() {
  const urlParams = new URLSearchParams(window.location.search);
  const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  let captured = false;

  utmKeys.forEach(key => {
    if (urlParams.has(key)) {
      utmParams[key] = urlParams.get(key);
      captured = true;
    }
  });

  if (captured) {
    sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(utmParams));
  } else {
    const savedUTM = sessionStorage.getItem(UTM_STORAGE_KEY);
    if (savedUTM) {
      try { utmParams = JSON.parse(savedUTM); } catch (e) { utmParams = {}; }
    }
  }
}

// -------------------------------------------------------------
// Feature 1: Abandoned Cart Event Logger Logic
// -------------------------------------------------------------
function handleAbandonedCartCheck() {
  if (cart && cart.length > 0) {
    const cartTotal = cart.reduce((acc, item) => acc + (Number(item.price) || 0), 0);
    const payload = {
      cartItemCount: cart.length,
      cartTotal: cartTotal.toFixed(2),
      items: cart.map(i => i.name),
      abandonedAt: new Date().toISOString()
    };

    // Client-side analytics trigger simulation (e.g. Klaviyo)
    if (window.klaviyo && typeof window.klaviyo.track === 'function') {
      window.klaviyo.track('Started Checkout', payload);
    } else if (typeof klaviyo !== 'undefined' && typeof klaviyo.track === 'function') {
      klaviyo.track('Started Checkout', payload);
    }

    dispatchWebhookEvent('ABANDONED_CART_DETECTED', payload);
  }
}

// -------------------------------------------------------------
// Feature 7: VIP Tier Expiration & Threshold Listener
// -------------------------------------------------------------
function checkTierExpiration() {
  const currentTier = localStorage.getItem(getTierStorageKey());
  if (currentTier === 'premium') {
    const expiry = localStorage.getItem(getExpiryStorageKey());
    if (expiry) {
      const now = new Date().getTime();
      const expiryTime = parseInt(expiry, 10);
      const remainingMs = expiryTime - now;
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

      if (remainingMs <= 0) {
        localStorage.setItem(getTierStorageKey(), 'normal');
        localStorage.removeItem(getExpiryStorageKey());
        vipWarningTriggered = false;
        updateUI();
        renderProducts();
        
        dispatchWebhookEvent('VIP_TIER_EXPIRED', { expiredAt: new Date().toISOString() });
        alert('Your Premium Membership has expired. You have been switched back to the Normal Tier.');
      } else if (remainingMs <= THREE_DAYS_MS && !vipWarningTriggered) {
        vipWarningTriggered = true;
        const daysLeft = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
        
        dispatchWebhookEvent('VIP_TIER_EXPIRING', {
          daysRemaining: daysLeft,
          expiresAt: new Date(expiryTime).toISOString()
        });

        const headerBadge = document.getElementById('headerTierBadge');
        if (headerBadge) {
          headerBadge.className = 'tier-badge tier-expiring';
          headerBadge.textContent = `VIP (${daysLeft}d left)`;
        }
      }
    }
  }
}

function getUserTier() {
  return localStorage.getItem(getTierStorageKey()) || 'normal';
}

function requireAuth(actionName = 'perform this action') {
  if (!currentUser) {
    alert(`Please log in or create an account to ${actionName}.`);
    const loginNav = document.querySelectorAll('.nav-btn')[4];
    switchModule('login', loginNav);
    return false;
  }
  return true;
}

// -------------------------------------------------------------
// 2. Navigation & UI Management
// -------------------------------------------------------------
function switchModule(moduleId, clickedBtn) {
  const modules = document.querySelectorAll('.module');
  modules.forEach(mod => mod.classList.remove('active'));

  const targetModule = document.getElementById(moduleId);
  if (targetModule) targetModule.classList.add('active');

  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => btn.classList.remove('active'));
  if (clickedBtn) clickedBtn.classList.add('active');

  if (moduleId === 'cart') {
    renderCart();
  }
  if (moduleId === 'orders') {
    renderOrders();
  }
}

// -------------------------------------------------------------
// Feature 5: Dynamic Custom User Metadata Aggregator & Preference Handler
// -------------------------------------------------------------
function aggregateUserMetadata() {
  if (!currentUser) return null;

  const totalOrdersCount = orders.length;
  const lastPurchaseDate = orders.length > 0 ? orders[0].date : 'N/A';
  const membershipTier = getUserTier();

  const userProfileData = {
    email: currentUser.email,
    membership_tier: membershipTier,
    total_orders_count: totalOrdersCount,
    last_purchase_date: lastPurchaseDate,
    optedInMarketing: currentUser.optedInMarketing || false
  };

  dispatchWebhookEvent('USER_PROFILE_UPDATED', userProfileData);
  return userProfileData;
}

async function toggleMarketingPreferences(isOptedIn) {
  if (!currentUser) return;

  currentUser.optedInMarketing = isOptedIn;
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser));

  try {
    const token = localStorage.getItem('shopsphere_token');
    await fetch(`${API_BASE_URL}/user/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ optedInMarketing: isOptedIn })
    });
  } catch (err) {
    console.warn('Failed to sync marketing preferences with backend API', err);
  }

  dispatchWebhookEvent('USER_PREFERENCES_UPDATED', {
    email: currentUser.email,
    optedInMarketing: isOptedIn,
    updatedAt: new Date().toISOString()
  });

  aggregateUserMetadata();
}

function updateUI() {
  const currentTier = getUserTier();
  const isPremium = currentTier === 'premium';

  const headerBadge = document.getElementById('headerTierBadge');
  if (headerBadge && !vipWarningTriggered) {
    headerBadge.className = isPremium ? 'tier-badge tier-prime' : 'tier-badge tier-normal';
    headerBadge.textContent = isPremium ? 'VIP Premium' : 'Normal User';
  }

  const shopActiveTierText = document.getElementById('shopActiveTierText');
  if (shopActiveTierText) {
    shopActiveTierText.textContent = isPremium ? 'VIP Premium (15% OFF Active)' : 'Normal User';
  }

  const upgradeBtnBox = document.getElementById('headerUpgradeBtnBox');
  if (upgradeBtnBox) {
    upgradeBtnBox.style.display = isPremium ? 'none' : 'block';
  }

  const homeUpgradeBtn = document.getElementById('homeUpgradeBtn');
  if (homeUpgradeBtn) {
    if (isPremium) {
      homeUpgradeBtn.textContent = 'Active Premium Member';
      homeUpgradeBtn.disabled = true;
      homeUpgradeBtn.style.opacity = '0.6';
      homeUpgradeBtn.style.cursor = 'not-allowed';
    } else {
      homeUpgradeBtn.textContent = 'Upgrade to Premium';
      homeUpgradeBtn.disabled = false;
      homeUpgradeBtn.style.opacity = '1';
      homeUpgradeBtn.style.cursor = 'pointer';
    }
  }

  const cartCount = document.getElementById('cartCount');
  if (cartCount) {
    cartCount.textContent = cart.length.toString();
  }

  const userProfileArea = document.getElementById('userProfileArea');
  const loginNavBtn = document.getElementById('loginNavBtn');
  const userNameDisplay = document.getElementById('userNameDisplay');
  const userAvatar = document.getElementById('userAvatar');
  const userOptInToggle = document.getElementById('userOptInToggle');

  if (currentUser) {
    if (userProfileArea) userProfileArea.style.display = 'flex';
    if (loginNavBtn) loginNavBtn.style.display = 'none';
    if (userNameDisplay) userNameDisplay.textContent = currentUser.name || currentUser.email;
    if (userAvatar) userAvatar.textContent = (currentUser.name || currentUser.email).charAt(0).toUpperCase();
    if (userOptInToggle) userOptInToggle.checked = currentUser.optedInMarketing || false;
  } else {
    if (userProfileArea) userProfileArea.style.display = 'none';
    if (loginNavBtn) loginNavBtn.style.display = 'inline-block';
  }
}

// -------------------------------------------------------------
// 3. Fetch & Render Shop Products (With Stock Badges)
// -------------------------------------------------------------
let isFetchingProducts = false;

async function fetchProducts() {
  const container = document.getElementById('productContainer');
  if (!container || isFetchingProducts) return;

  isFetchingProducts = true;
  container.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">Loading products...</p>';

  try {
    const response = await fetch(`${API_BASE_URL}/products`);
    if (!response.ok) throw new Error(`Server status ${response.status}`);

    const rawProducts = await response.json();

    const uniqueMap = new Map();
    rawProducts.forEach(item => {
      const identifier = item._id ? item._id.toString() : (item.name ? item.name.trim().toLowerCase() : null);
      if (identifier && !uniqueMap.has(identifier)) {
        if (item.stock === undefined) item.stock = 5;
        uniqueMap.set(identifier, item);
      }
    });

    products = Array.from(uniqueMap.values());

    if (!products || products.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 2rem;">
          <p style="font-size: 1.1rem; color: #475569; margin-bottom: 1rem;">No products found in database.</p>
          <button class="btn btn-primary" onclick="triggerSeedProducts()">Click to Load Sample Products into MongoDB</button>
        </div>`;
      const countBadge = document.getElementById('productCountBadge');
      if (countBadge) countBadge.textContent = '(0 Products)';
      return;
    }

    renderProducts();
  } catch (error) {
    console.error('Error fetching products:', error);
    container.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #ef4444; font-weight: bold;">Failed to load products. Check server status.</p>`;
  } finally {
    isFetchingProducts = false;
  }
}

async function triggerSeedProducts() {
  try {
    const response = await fetch(`${API_BASE_URL}/seed-products`);
    const data = await response.json();
    alert(data.message || 'Database seeded successfully!');
    products = [];
    await fetchProducts();
  } catch (error) {
    alert('Failed to seed database.');
  }
}

function renderProducts() {
  const container = document.getElementById('productContainer');
  const countBadge = document.getElementById('productCountBadge');
  const currentTier = getUserTier();

  if (countBadge) countBadge.textContent = `(${products.length} Products Available)`;
  if (!container || !products || products.length === 0) return;

  const isPremium = currentTier === 'premium';

  container.innerHTML = products.map(product => {
    const originalPrice = Number(product.price) || 0;
    const finalPrice = isPremium ? (originalPrice * 0.85).toFixed(2) : originalPrice.toFixed(2);
    const shippingText = isPremium ? '⚡ FREE 1-Day Express Delivery' : '🚚 $4.99 Standard Shipping';
    
    const stockCount = product.stock !== undefined ? product.stock : 5;
    let stockClass = 'stock-in';
    let stockText = `${stockCount} In Stock`;
    if (stockCount === 0) {
      stockClass = 'stock-out';
      stockText = 'Out of Stock';
    } else if (stockCount <= 2) {
      stockClass = 'stock-low';
      stockText = `Only ${stockCount} Left!`;
    }

    const isDisabled = stockCount === 0 ? 'disabled' : '';

    return `
      <div class="product-card" style="border: 1px solid #cbd5e1; border-radius: 8px; padding: 1rem; background: white; display: flex; flex-direction: column; justify-content: space-between; position: relative;">
        <span class="stock-badge ${stockClass}">${stockText}</span>
        <div>
          <img src="${product.imageUrl || 'https://via.placeholder.com/200'}" alt="${product.name}" style="width: 100%; height: 160px; object-fit: cover; border-radius: 6px;">
          <h3 style="margin: 0.75rem 0 0.25rem 0;">${product.name}</h3>
          <p style="color: #64748b; font-size: 0.85rem; margin-bottom: 0.75rem;">${product.description || 'Quality product available now.'}</p>
        </div>
        <div>
          <div style="margin-bottom: 0.5rem;">
            <span style="font-weight: bold; font-size: 1.2rem; color: #1e293b;">$${finalPrice}</span>
            ${isPremium ? `<span style="text-decoration: line-through; color: #94a3b8; font-size: 0.85rem; margin-left: 0.5rem;">$${originalPrice.toFixed(2)}</span>` : ''}
          </div>
          <p style="font-size: 0.75rem; color: ${isPremium ? '#16a34a' : '#64748b'}; font-weight: 600; margin-bottom: 0.75rem;">${shippingText}</p>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-secondary" style="flex: 1; font-size: 0.85rem; padding: 0.5rem 0.25rem;" onclick="addToCart('${product._id}')" ${isDisabled}>Add to Cart</button>
            <button class="btn btn-success" style="flex: 1; font-size: 0.85rem; padding: 0.5rem 0.25rem;" onclick="buyNow('${product._id}')" ${isDisabled}>Buy Now</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// -------------------------------------------------------------
// 4. Cart Management & Time-In-Cart Tracker
// -------------------------------------------------------------
async function addToCart(productId) {
  if (!requireAuth('add items to your cart')) return;

  const product = products.find(p => p._id === productId);
  if (!product || product.stock === 0) return;

  const formattedProductId = (typeof product._id === 'object' && product._id !== null)
    ? product._id.toString()
    : String(product._id);

  const cartItem = {
    cartId: Date.now().toString(),
    productId: formattedProductId,
    name: product.name,
    category: product.category || 'General',
    price: product.price,
    addedAt: new Date().toISOString()
  };

  cart.push(cartItem);
  localStorage.setItem(getCartStorageKey(), JSON.stringify(cart));
  updateUI();

  try {
    const token = localStorage.getItem('shopsphere_token');
    await fetch(`${API_BASE_URL}/cart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        cartId: cartItem.cartId,
        productId: cartItem.productId,
        name: cartItem.name,
        category: cartItem.category,
        price: cartItem.price,
        quantity: 1,
        userEmail: currentUser ? currentUser.email : 'guest'
      })
    });
  } catch (err) {
    console.warn('Failed to sync cart item with backend API', err);
  }

  // STEP 4: Track "Added to Cart" event in Klaviyo
  if (window.klaviyo && typeof window.klaviyo.track === 'function') {
    window.klaviyo.track('Added to Cart', {
      'ProductName': product.name,
      'ProductID': formattedProductId,
      'Price': product.price,
      'Quantity': 1,
      'Category': product.category || 'General'
    });
  } else if (typeof klaviyo !== 'undefined' && typeof klaviyo.track === 'function') {
    klaviyo.track('Added to Cart', {
      'ProductName': product.name,
      'ProductID': formattedProductId,
      'Price': product.price,
      'Quantity': 1,
      'Category': product.category || 'General'
    });
  }

  dispatchWebhookEvent('ADD_TO_CART', { productId: formattedProductId, product: product.name, price: product.price });
  alert(`Added "${product.name}" to cart!`);
}

function removeFromCart(cartId) {
  cart = cart.filter(item => item.cartId !== cartId);
  localStorage.setItem(getCartStorageKey(), JSON.stringify(cart));
  updateUI();
  renderCart();
}

function renderCart() {
  const emptyMsg = document.getElementById('emptyCartMsg');
  const cartTable = document.getElementById('cartTable');
  const tbody = document.getElementById('cartTableBody');
  const isPremium = getUserTier() === 'premium';

  if (!tbody || !emptyMsg || !cartTable) return;

  lastRenderedCartLength = cart.length;

  if (cart.length === 0) {
    emptyMsg.style.display = 'block';
    cartTable.style.display = 'none';
    return;
  }

  emptyMsg.style.display = 'none';
  cartTable.style.display = 'table';

  tbody.innerHTML = cart.map((item, index) => {
    const originalPrice = Number(item.price) || 0;
    const finalPrice = isPremium ? (originalPrice * 0.85).toFixed(2) : originalPrice.toFixed(2);
    const shippingText = isPremium ? '⚡ FREE Express' : '🚚 $4.99 Standard';

    return `
      <tr>
        <td style="font-weight: 600;">${item.name}</td>
        <td>${item.category}</td>
        <td>$${finalPrice} ${isPremium ? '<small style="color: #16a34a;">(15% off)</small>' : ''}</td>
        <td>${shippingText}</td>
        <td id="cart-timer-${index}">Just added</td>
        <td>
          <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;" onclick="removeFromCart('${item.cartId}')">Remove</button>
        </td>
      </tr>`;
  }).join('');

  updateCartItemTimestamps();
}

function startCartTimers() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateCartItemTimestamps, 1000);
}

function updateCartItemTimestamps() {
  const now = new Date();
  cart.forEach((item, index) => {
    const el = document.getElementById(`cart-timer-${index}`);
    if (!el) return;

    const addedTime = new Date(item.addedAt).getTime();
    const diffSeconds = Math.max(0, Math.floor((now.getTime() - addedTime) / 1000));
    
    if (diffSeconds < 60) {
      el.innerText = `${diffSeconds}s ago`;
    } else {
      const mins = Math.floor(diffSeconds / 60);
      const secs = diffSeconds % 60;
      el.innerText = `${mins}m ${secs}s ago`;
    }
  });
}

// -------------------------------------------------------------
// 5. Checkout, Stock Reduction & Promo Code Validation
// -------------------------------------------------------------
function buyNow(productId) {
  if (!requireAuth('purchase products')) return;

  const product = products.find(p => p._id === productId);
  if (!product || product.stock === 0) return;

  pendingCheckoutProduct = product;
  appliedPromo = null;

  const isPremium = getUserTier() === 'premium';
  const originalPrice = Number(product.price) || 0;
  const finalPrice = isPremium ? (originalPrice * 0.85).toFixed(2) : originalPrice.toFixed(2);

  const itemDetails = document.getElementById('paymentItemDetails');
  const deliveryDetails = document.getElementById('paymentDeliverySpeed');
  const promoInput = document.getElementById('promoCodeInput');
  const promoMsg = document.getElementById('promoMessage');

  if (promoInput) promoInput.value = '';
  if (promoMsg) promoMsg.style.display = 'none';

  if (itemDetails) itemDetails.textContent = `${product.name} — Total: $${finalPrice}`;
  if (deliveryDetails) {
    deliveryDetails.textContent = isPremium ? 'Speed: ⚡ FREE 1-Day Express Delivery' : 'Speed: 🚚 $4.99 Standard Delivery (5-7 days)';
  }

  // Feature 4: Display captured UTM Attribution in modal
  const utmBadge = document.getElementById('utmAttributionBadge');
  const utmDetails = document.getElementById('utmBadgeDetails');
  if (utmBadge && utmDetails) {
    if (utmParams && Object.keys(utmParams).length > 0) {
      utmBadge.style.display = 'block';
      utmDetails.textContent = `${utmParams.utm_source || 'direct'} / ${utmParams.utm_campaign || 'none'}`;
    } else {
      utmBadge.style.display = 'none';
    }
  }

  // STEP 4: Track "Started Checkout" when initiating checkout
  if (window.klaviyo && typeof window.klaviyo.track === 'function') {
    window.klaviyo.track('Started Checkout', {
      'ItemCount': 1,
      'TotalValue': Number(finalPrice),
      'Items': [product.name]
    });
  } else if (typeof klaviyo !== 'undefined' && typeof klaviyo.track === 'function') {
    klaviyo.track('Started Checkout', {
      'ItemCount': 1,
      'TotalValue': Number(finalPrice),
      'Items': [product.name]
    });
  }

  const modal = document.getElementById('paymentModal');
  if (modal) modal.style.display = 'flex';
}

function applyPromoCode() {
  const input = document.getElementById('promoCodeInput');
  const msg = document.getElementById('promoMessage');
  if (!input || !msg || !pendingCheckoutProduct) return;

  const code = input.value.trim().toUpperCase();
  if (PROMO_CODES[code]) {
    appliedPromo = PROMO_CODES[code];
    msg.innerText = `Promo Code Applied: ${PROMO_CODES[code].desc}`;
    msg.className = 'promo-success';
    msg.style.display = 'block';

    const isPremium = getUserTier() === 'premium';
    const originalPrice = Number(pendingCheckoutProduct.price) || 0;
    let basePrice = isPremium ? originalPrice * 0.85 : originalPrice;

    if (appliedPromo.type === 'PERCENT') {
      basePrice *= (1 - appliedPromo.value);
    } else if (appliedPromo.type === 'FIXED') {
      basePrice = Math.max(0, basePrice - appliedPromo.value);
    }

    document.getElementById('paymentItemDetails').textContent = `${pendingCheckoutProduct.name} — Total: $${basePrice.toFixed(2)} (Promo Applied)`;
  } else {
    appliedPromo = null;
    msg.innerText = 'Invalid promo code';
    msg.className = 'promo-error';
    msg.style.display = 'block';
  }
}

function closePaymentModal() {
  pendingCheckoutProduct = null;
  appliedPromo = null;
  const modal = document.getElementById('paymentModal');
  if (modal) modal.style.display = 'none';
}

async function processInstantPayment() {
  if (!pendingCheckoutProduct) return;

  if (pendingCheckoutProduct.stock && pendingCheckoutProduct.stock > 0) {
    pendingCheckoutProduct.stock -= 1;
  }

  const isPremium = getUserTier() === 'premium';
  const originalPrice = Number(pendingCheckoutProduct.price) || 0;
  let finalPrice = isPremium ? originalPrice * 0.85 : originalPrice;

  if (appliedPromo) {
    if (appliedPromo.type === 'PERCENT') {
      finalPrice *= (1 - appliedPromo.value);
    } else if (appliedPromo.type === 'FIXED') {
      finalPrice = Math.max(0, finalPrice - appliedPromo.value);
    }
  }

  const orderRecord = {
    orderId: 'ORD-' + Date.now(),
    productName: pendingCheckoutProduct.name,
    pricePaid: finalPrice.toFixed(2),
    shippingSpeed: isPremium ? '1-Day Express' : 'Standard Delivery',
    tierUsed: isPremium ? 'VIP Premium' : 'Normal',
    date: new Date().toLocaleString(),
    timestamp: Date.now(),
    // Feature 4: Attach Attribution Data
    attribution: { ...utmParams },
    // Feature 6: Schedule Post-Purchase Review Payload
    reviewRequestStatus: 'PENDING_DELIVERY'
  };

  orders.unshift(orderRecord);
  localStorage.setItem(getOrdersStorageKey(), JSON.stringify(orders));

  try {
    const token = localStorage.getItem('shopsphere_token');
    await fetch(`${API_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify(orderRecord)
    });
  } catch (err) {
    console.warn('Failed to sync order with backend API', err);
  }

  // Feature 2: Dispatch ORDER_COMPLETED webhook payload
  dispatchWebhookEvent('ORDER_COMPLETED', orderRecord);

  // Feature 5: Update custom user profile metadata properties
  aggregateUserMetadata();

  // Feature 6: Trigger backend post-purchase review scheduler
  schedulePostPurchaseReviewTrigger(orderRecord);

  closePaymentModal();
  renderProducts();
  alert(`Order Placed Successfully! Reference: ${orderRecord.orderId}`);
  switchModule('orders', document.querySelectorAll('.nav-btn')[3]);
}

// -------------------------------------------------------------
// Feature 6: Post-Purchase Review Request Trigger Engine
// -------------------------------------------------------------
async function schedulePostPurchaseReviewTrigger(orderRecord) {
  const deliveryDelayDays = 3; // Scheduled review trigger after 3 days
  const reviewPayload = {
    orderId: orderRecord.orderId,
    customerEmail: currentUser ? currentUser.email : 'guest',
    productName: orderRecord.productName,
    scheduledTriggerDate: new Date(Date.now() + (deliveryDelayDays * 24 * 60 * 60 * 1000)).toISOString()
  };

  dispatchWebhookEvent('POST_PURCHASE_REVIEW_SCHEDULED', reviewPayload);

  try {
    await fetch(`${API_BASE_URL}/orders/schedule-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewPayload)
    });
  } catch (err) {
    console.warn('Backend scheduler unavailable. Scheduled locally.', reviewPayload);
  }
}

function renderOrders() {
  const emptyMsg = document.getElementById('emptyOrdersMsg');
  const ordersTable = document.getElementById('ordersTable');
  const tbody = document.getElementById('ordersTableBody');

  if (!tbody || !emptyMsg || !ordersTable) return;

  lastRenderedOrdersLength = orders.length;

  if (orders.length === 0) {
    emptyMsg.style.display = 'block';
    ordersTable.style.display = 'none';
    return;
  }

  emptyMsg.style.display = 'none';
  ordersTable.style.display = 'table';

  tbody.innerHTML = orders.map(ord => {
    const utmText = ord.attribution && ord.attribution.utm_source 
      ? `<span class="utm-tag">${ord.attribution.utm_source} / ${ord.attribution.utm_campaign || 'default'}</span>` 
      : '<span style="color: #94a3b8; font-size: 0.8rem;">Direct</span>';

    const reviewStatusText = ord.reviewRequestStatus === 'SENT' 
      ? '<span class="review-status review-sent">Sent</span>' 
      : '<span class="review-status review-pending">Scheduled (3 Days)</span>';

    return `
    <tr>
      <td style="font-weight: 600;">${ord.productName}</td>
      <td>$${ord.pricePaid}</td>
      <td>${ord.shippingSpeed}</td>
      <td><span class="tier-badge ${ord.tierUsed.includes('VIP') ? 'tier-prime' : 'tier-normal'}">${ord.tierUsed}</span></td>
      <td>${utmText}</td>
      <td>${ord.date}</td>
      <td>${reviewStatusText}</td>
    </tr>`;
  }).join('');
}

// -------------------------------------------------------------
// 6. Premium Subscriptions & Tier Upgrades
// -------------------------------------------------------------
function openSubscriptionModal() {
  if (!requireAuth('subscribe to VIP Premium')) return;

  if (getUserTier() === 'premium') {
    alert('You are already a VIP Premium member!');
    return;
  }
  const modal = document.getElementById('subscriptionModal');
  if (modal) modal.style.display = 'flex';
}

function closeSubscriptionModal() {
  const modal = document.getElementById('subscriptionModal');
  if (modal) modal.style.display = 'none';
}

function confirmPremiumUpgrade() {
  if (!requireAuth('subscribe to VIP Premium')) return;

  if (getUserTier() === 'premium') {
    alert('You are already a VIP Premium member!');
    closeSubscriptionModal();
    return;
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const expiryTime = new Date().getTime() + THIRTY_DAYS_MS;

  localStorage.setItem(getTierStorageKey(), 'premium');
  localStorage.setItem(getExpiryStorageKey(), expiryTime.toString());
  vipWarningTriggered = false;

  closeSubscriptionModal();
  updateUI();
  renderProducts();

  // Feature 2 & 5: Dispatch event & update user profile properties
  dispatchWebhookEvent('TIER_UPGRADED', { newTier: 'premium', expiresAt: new Date(expiryTime).toISOString() });
  aggregateUserMetadata();

  alert('Congratulations! You are now upgraded to VIP Premium for 30 days. Enjoy 15% off and Free Express Delivery!');
}

// -------------------------------------------------------------
// 7. User Authentication & Consent Opt-In Handlers
// -------------------------------------------------------------
function resetAuthForms() {
  const loginBox = document.getElementById('loginBox');
  const signupBox = document.getElementById('signupBox');

  if (loginBox && signupBox) {
    loginBox.style.display = 'block';
    signupBox.style.display = 'none';
  }
}

function toggleAuthForms() {
  const loginBox = document.getElementById('loginBox');
  const signupBox = document.getElementById('signupBox');

  if (loginBox.style.display === 'none') {
    loginBox.style.display = 'block';
    signupBox.style.display = 'none';
  } else {
    loginBox.style.display = 'none';
    signupBox.style.display = 'block';
  }
}

async function handleAuth(event, type) {
  event.preventDefault();

  try {
    if (type === 'Login') {
      const email = document.getElementById('loginEmail').value.trim().toLowerCase();
      const password = document.getElementById('loginPassword').value;

      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Login failed. Invalid email or password.');
        return;
      }

      currentUser = data.user;
      if (data.token) {
        localStorage.setItem('shopsphere_token', data.token);
      }

      dispatchWebhookEvent('USER_LOGGED_IN', { email: currentUser.email });
    } else {
      const firstName = document.getElementById('signupFirstName').value.trim();
      const lastName = document.getElementById('signupLastName').value.trim();
      const email = document.getElementById('signupEmail').value.trim().toLowerCase();
      const password = document.getElementById('signupPassword').value;
      const optInBox = document.getElementById('signupOptIn');
      const optedInMarketing = optInBox ? optInBox.checked : false;
      const name = `${firstName} ${lastName}`.trim();

      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, optedInMarketing })
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || 'Registration failed.');
        return;
      }

      currentUser = data.user || { name, email, optedInMarketing };
      if (data.token) {
        localStorage.setItem('shopsphere_token', data.token);
      }

      // Feature 2: Dispatch USER_REGISTERED Webhook Payload
      dispatchWebhookEvent('USER_REGISTERED', {
        email,
        name,
        optedInMarketing,
        registeredAt: new Date().toISOString()
      });
    }

    // STEP 3: Identify the user in Klaviyo on successful login/signup
    if (window.klaviyo && typeof window.klaviyo.identify === 'function') {
      const nameParts = (currentUser.name || '').split(' ');
      window.klaviyo.identify({
        '$email': currentUser.email,
        '$first_name': nameParts[0] || '',
        '$last_name': nameParts.slice(1).join(' ') || ''
      });
    } else if (typeof klaviyo !== 'undefined' && typeof klaviyo.identify === 'function') {
      const nameParts = (currentUser.name || '').split(' ');
      klaviyo.identify({
        '$email': currentUser.email,
        '$first_name': nameParts[0] || '',
        '$last_name': nameParts.slice(1).join(' ') || ''
      });
    }

    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser));
    
    loadStoredData();
    checkTierExpiration();
    updateUI();
    aggregateUserMetadata();
    
    lastRenderedCartLength = -1;
    lastRenderedOrdersLength = -1;

    alert(`Welcome, ${currentUser.name || currentUser.email}!`);
    switchModule('shop', document.querySelectorAll('.nav-btn')[1]);
  } catch (error) {
    console.error('Authentication Error:', error);
    alert('Unable to connect to authentication server.');
  }
}

function handleLogout() {
  // Feature 1: Fire cart check on explicit logout
  handleAbandonedCartCheck();

  if (currentUser) {
    dispatchWebhookEvent('USER_LOGGED_OUT', { email: currentUser.email });
  }

  currentUser = null;
  localStorage.removeItem(USER_STORAGE_KEY);
  localStorage.removeItem('shopsphere_token');
  
  loadStoredData();
  resetAuthForms();
  updateUI();
  
  lastRenderedCartLength = -1;
  lastRenderedOrdersLength = -1;

  alert('You have logged out successfully.');
  switchModule('home', document.querySelectorAll('.nav-btn')[0]);
}