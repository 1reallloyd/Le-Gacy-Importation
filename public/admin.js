(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const root = $('#adminRoot');
  const modalRoot = $('#adminModal');
  const money = (value) => 'GH₵ ' + Number(value || 0).toLocaleString('en-GH', { maximumFractionDigits: 2 });
  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-5 5"/>',
    sound: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    edit: '<path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    external: '<path d="M14 3h7v7M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
  };
  const state = {
    email: '', page: 'overview', products: [], orders: [], categories: [], store: {}, filter: '', range: 30,
    notifications: [], notificationOpen: false, knownOrderRefs: new Set(), knownProductIds: new Set(),
    knownOrderStatuses: new Map(), knownCustomerKeys: new Set(), knownInventorySignals: new Map(),
    knownProductNames: new Map(),
    monitorReady: false, pollTimer: null, pollRunning: false, pollErrorNotified: false,
    analytics: null, analyticsDays: 30, analyticsLoading: false, analyticsError: '',
    soundEnabled: true
  };
  const NOTIFICATION_LIMIT = 50;
  let dashboardAudioContext = null;
  let analyticsRequestId = 0;

  function soundPreferenceKey(email) {
    return 'lg_admin_order_sound_' + encodeURIComponent(String(email || '').toLowerCase());
  }

  function loadSoundPreference(email) {
    try { return localStorage.getItem(soundPreferenceKey(email)) !== 'off'; }
    catch { return true; }
  }

  function saveSoundPreference() {
    if (!state.email) return;
    try { localStorage.setItem(soundPreferenceKey(state.email), state.soundEnabled ? 'on' : 'off'); }
    catch (error) { console.warn('Dashboard sound preference could not be saved:', error.message); }
  }

  function syncSoundControl() {
    const button = $('.admin-sound-toggle');
    if (!button) return;
    const ready = dashboardAudioContext && dashboardAudioContext.state === 'running';
    const enabled = state.soundEnabled;
    const label = enabled ? 'Order sound on' : 'Order sound off';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled && !ready
      ? 'Sound is on. Click or tap the dashboard to activate audio.'
      : label;
    button.classList.toggle('is-enabled', enabled);
    button.replaceChildren(icon(enabled ? 'sound' : 'mute', 17), h('span', { text: label }));
  }

  function primeDashboardAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      syncSoundControl();
      return;
    }
    try {
      if (!dashboardAudioContext) {
        dashboardAudioContext = new AudioContextClass();
        dashboardAudioContext.addEventListener('statechange', syncSoundControl);
      }
      if (dashboardAudioContext.state === 'running') {
        syncSoundControl();
        return;
      }
      dashboardAudioContext.resume().then(() => {
        syncSoundControl();
      }).catch((error) => {
        console.warn('Dashboard sound could not be enabled:', error.message);
        syncSoundControl();
      });
    } catch (error) {
      console.warn('Dashboard sound could not be enabled:', error.message);
      syncSoundControl();
    }
  }

  function toggleDashboardSound() {
    if (state.soundEnabled) {
      state.soundEnabled = false;
      saveSoundPreference();
      syncSoundControl();
      return;
    }
    state.soundEnabled = true;
    saveSoundPreference();
    primeDashboardAudio();
    syncSoundControl();
  }

  function activateDashboardAudio(event) {
    if (!state.email || !state.soundEnabled
      || (dashboardAudioContext && dashboardAudioContext.state === 'running')
      || (event.target instanceof Element && event.target.closest('.admin-sound-toggle'))) return;
    primeDashboardAudio();
  }

  function playNewOrderSound() {
    if (!state.email || !state.soundEnabled || !state.monitorReady
      || document.visibilityState !== 'visible' || !root.querySelector('.admin-shell')
      || !dashboardAudioContext || dashboardAudioContext.state !== 'running') return;
    try {
      const now = dashboardAudioContext.currentTime;
      const oscillator = dashboardAudioContext.createOscillator();
      const gain = dashboardAudioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, now);
      oscillator.frequency.setValueAtTime(880, now + 0.16);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
      oscillator.connect(gain);
      gain.connect(dashboardAudioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.4);
    } catch (error) {
      console.warn('New-order sound could not be played:', error.message);
    }
  }

  function icon(name, size = 18) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = icons[name] || '';
    return svg;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked') el.checked = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function toast(message, error = false) {
    const el = h('div', { class: 'admin-toast ' + (error ? 'error' : 'success'), text: message });
    $('#adminToasts').append(el);
    setTimeout(() => el.remove(), 3500);
  }

  function notificationStorageKey() {
    return 'lg_admin_notifications_' + encodeURIComponent(state.email.toLowerCase());
  }

  function notificationSnapshotStorageKey() {
    return 'lg_admin_snapshot_' + encodeURIComponent(state.email.toLowerCase());
  }

  function readNotificationSnapshot() {
    try {
      const snapshot = JSON.parse(localStorage.getItem(notificationSnapshotStorageKey()) || 'null');
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.orderRefs)
        || !Array.isArray(snapshot.orderStatuses) || !Array.isArray(snapshot.customerKeys)
        || !Array.isArray(snapshot.products)) return null;
      return {
        orderRefs: snapshot.orderRefs.filter((ref) => typeof ref === 'string'),
        orderStatuses: snapshot.orderStatuses.filter((item) => Array.isArray(item)
          && typeof item[0] === 'string' && typeof item[1] === 'string'),
        customerKeys: snapshot.customerKeys.filter((key) => typeof key === 'string' && key),
        products: snapshot.products.filter((item) => item && typeof item.id === 'string'
          && typeof item.name === 'string' && typeof item.signal === 'string')
      };
    } catch { return null; }
  }

  function saveNotificationSnapshot() {
    try {
      localStorage.setItem(notificationSnapshotStorageKey(), JSON.stringify({
        version: 1,
        orderRefs: [...state.knownOrderRefs],
        orderStatuses: [...state.knownOrderStatuses],
        customerKeys: [...state.knownCustomerKeys],
        products: [...state.knownProductIds].map((id) => ({
          id,
          name: state.knownProductNames.get(id) || id,
          signal: state.knownInventorySignals.get(id) || 'untracked'
        }))
      }));
    } catch { /* The live dashboard still tracks changes until this page is closed. */ }
  }

  function readNotifications() {
    try {
      const saved = JSON.parse(localStorage.getItem(notificationStorageKey()) || '[]');
      if (!Array.isArray(saved)) return [];
      return saved.filter((item) => item && typeof item.id === 'string'
        && typeof item.title === 'string' && typeof item.message === 'string'
        && typeof item.createdAt === 'string' && typeof item.read === 'boolean'
        && !item.id.startsWith('overview:'))
        .slice(0, NOTIFICATION_LIMIT);
    } catch { return []; }
  }

  function saveNotifications() {
    try { localStorage.setItem(notificationStorageKey(), JSON.stringify(state.notifications.slice(0, NOTIFICATION_LIMIT))); }
    catch { /* Notifications remain available until this page is closed. */ }
  }

  function addNotification(id, title, message, type) {
    if (state.notifications.some((item) => item.id === id)) return false;
    state.notifications.unshift({ id, title, message, type, createdAt: new Date().toISOString(), read: false });
    state.notifications = state.notifications.slice(0, NOTIFICATION_LIMIT);
    saveNotifications();
    syncSidebarIndicators();
    const wrapper = $('.admin-notifications');
    if (wrapper) {
      if (state.notificationOpen) renderNotificationPanel(wrapper);
      else syncNotificationButton(wrapper);
    }
    return true;
  }

  function addActivityNotification(id, title, message, section) {
    return Number(addNotification(id, title, message, section));
  }

  function notificationSection(type) {
    if (type === 'order') return 'orders';
    if (type === 'product') return 'products';
    return type;
  }

  function customerKeyForOrder(order) {
    const customer = order.customer || {};
    return customer.phone || customer.email || customer.name || '';
  }

  function inventorySignal(product) {
    if (Number.isInteger(product.stock)) {
      if (product.stock <= 0) return product.preOrder && !product.inStock ? 'preorder' : 'out';
      if (product.inStock && product.stock <= 5) return 'low';
      return 'normal';
    }
    return !product.inStock && !product.preOrder ? 'out' : 'untracked';
  }

  function isPaidStatus(status) {
    return ['confirmed', 'processing', 'dispatched', 'delivered'].includes(status);
  }

  function isPaidOrder(order) {
    return isPaidStatus(order.status);
  }

  function statusLabel(status) {
    const labels = {
      awaiting_payment: 'Pending', payment_submitted: 'Payment review', confirmed: 'Confirmed',
      processing: 'Processing your order', dispatched: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled'
    };
    return labels[status] || 'updated';
  }

  function sectionHasUnread(section) {
    if (section === 'overview') return state.notifications.some((item) => !item.read);
    return state.notifications.some((item) => !item.read && notificationSection(item.type) === section);
  }

  function syncSidebarIndicators() {
    const sidebar = $('#adminSidebar');
    if (!sidebar) return;
    sidebar.querySelectorAll('.admin-nav[data-section]').forEach((button) => {
      const section = button.dataset.section;
      const unread = sectionHasUnread(section);
      const indicator = $('.admin-nav-indicator', button);
      if (unread && !indicator) {
        button.append(h('span', { class: 'admin-nav-indicator', 'aria-hidden': 'true' }));
        button.setAttribute('aria-label', button.dataset.label + ', unread updates');
      } else if (!unread && indicator) {
        indicator.remove();
        button.removeAttribute('aria-label');
      }
    });
  }

  function unreadNotificationCount() {
    return state.notifications.filter((item) => !item.read).length;
  }

  function notificationTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = {};
    try { data = await response.json(); } catch { /* The server may return an empty response. */ }
    if (!response.ok) {
      if (response.status === 401 && path !== '/api/admin/login') showLogin('Your session expired. Please sign in again.');
      const error = new Error(data.error || 'The request could not be completed.');
      error.rows = data.rows;
      throw error;
    }
    return data;
  }

  function showLogin(message = '') {
    stopMonitoring();
    state.email = '';
    state.products = [];
    state.orders = [];
    root.replaceChildren(h('section', { class: 'admin-login' },
      h('form', { class: 'admin-login-card', onsubmit: signIn },
        h('a', { class: 'brand', href: '/', 'aria-label': "Le-Gacy's Importation storefront" },
          h('img', { class: 'brand-logo', src: '/legacys-logo.svg', alt: '' })),
        h('h1', { text: 'Welcome back' }),
        h('p', { text: 'Sign in to manage your store. Admin access is invitation-only.' }),
        h('div', { class: 'field' }, h('label', { for: 'adminEmail', text: 'Admin email' }),
          h('input', { class: 'input', id: 'adminEmail', type: 'email', autocomplete: 'username', maxlength: '254', required: true, placeholder: 'name@example.com' })),
        h('div', { class: 'field' }, h('label', { for: 'adminPassword', text: 'Password' }),
          h('input', { class: 'input', id: 'adminPassword', type: 'password', autocomplete: 'current-password', maxlength: '256', required: true, placeholder: 'Enter your password' })),
        h('p', { class: 'err', id: 'adminLoginError', role: 'alert', text: message }),
        h('button', { class: 'btn btn-wide', type: 'submit', text: 'Sign in to dashboard' }),
        h('p', { class: 'small muted', style: 'margin-top:16px;text-align:center', text: 'Need help? Contact your store administrator.' }))));
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    button.textContent = 'Signing in…';
    const email = $('#adminEmail').value.trim();
    const password = $('#adminPassword').value;
    state.soundEnabled = loadSoundPreference(email);
    if (state.soundEnabled) primeDashboardAudio();
    try {
      const session = await request('/api/admin/login', { email, password });
      state.email = session.email;
      await loadData();
      startMonitoring();
      state.page = 'overview';
      renderShell();
    } catch (error) {
      const loginError = $('#adminLoginError');
      if (!loginError) {
        showLogin(error.message);
        return;
      }
      loginError.textContent = error.message;
      $('#adminPassword').value = '';
      button.disabled = false;
      button.textContent = 'Sign in to dashboard';
    }
  }

  async function loadData() {
    const data = await request('/api/admin/dashboard');
    state.products = data.products;
    state.orders = data.orders;
    state.categories = data.categories;
    state.store = data.store;
  }

  async function loadAnalytics(days = state.analyticsDays) {
    const requestId = ++analyticsRequestId;
    state.analyticsDays = days;
    state.analyticsLoading = true;
    state.analyticsError = '';
    try {
      const data = await request('/api/admin/analytics?days=' + encodeURIComponent(days));
      if (requestId === analyticsRequestId) {
        state.analytics = data;
        state.analyticsDays = days;
      }
      return data;
    } catch (error) {
      if (requestId !== analyticsRequestId) return null;
      state.analyticsError = error.message;
      throw error;
    } finally {
      if (requestId === analyticsRequestId) state.analyticsLoading = false;
    }
  }

  function navigateToPage(id) {
    state.page = id;
    if (id !== 'performance') {
      renderShell();
      return;
    }
    const loading = loadAnalytics();
    renderShell();
    loading.then(() => {
      if (state.page === 'performance') renderShell();
    }).catch((error) => {
      if (state.page === 'performance') renderShell();
      toast('Store performance could not be loaded: ' + error.message, true);
    });
  }

  function changeAnalyticsRange(days) {
    const loading = loadAnalytics(days);
    renderShell();
    loading.then(() => {
      if (state.page === 'performance') renderShell();
    }).catch((error) => {
      if (state.page === 'performance') renderShell();
      toast('Store performance could not be loaded: ' + error.message, true);
    });
  }

  function startMonitoring() {
    stopMonitoring();
    state.notifications = readNotifications();
    const snapshot = readNotificationSnapshot();
    if (snapshot) {
      state.knownOrderRefs = new Set(snapshot.orderRefs);
      state.knownProductIds = new Set(snapshot.products.map((product) => product.id));
      state.knownOrderStatuses = new Map(snapshot.orderStatuses);
      state.knownCustomerKeys = new Set(snapshot.customerKeys);
      state.knownInventorySignals = new Map(snapshot.products.map((product) => [product.id, product.signal]));
      state.knownProductNames = new Map(snapshot.products.map((product) => [product.id, product.name]));
    } else {
      state.knownOrderRefs = new Set(state.orders.map((order) => order.ref));
      state.knownProductIds = new Set(state.products.map((product) => product.id));
      state.knownOrderStatuses = new Map(state.orders.map((order) => [order.ref, order.status]));
      state.knownCustomerKeys = new Set(state.orders.map(customerKeyForOrder).filter(Boolean));
      state.knownInventorySignals = new Map(state.products.map((product) => [product.id, inventorySignal(product)]));
      state.knownProductNames = new Map(state.products.map((product) => [product.id, product.name]));
      saveNotificationSnapshot();
    }
    state.monitorReady = true;
    state.pollErrorNotified = false;
    state.pollTimer = setInterval(pollForChanges, 30000);
    pollForChanges();
  }

  function stopMonitoring() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.monitorReady = false;
    state.pollRunning = false;
    state.notificationOpen = false;
    state.knownOrderRefs.clear();
    state.knownProductIds.clear();
    state.knownOrderStatuses.clear();
    state.knownCustomerKeys.clear();
    state.knownInventorySignals.clear();
    state.knownProductNames.clear();
  }

  async function pollForChanges() {
    if (state.pollRunning || !state.email || document.visibilityState === 'hidden') return false;
    state.pollRunning = true;
    try {
      const data = await request('/api/admin/dashboard');
      if (!state.monitorReady) return false;
      const newOrders = data.orders.filter((order) => !state.knownOrderRefs.has(order.ref));
      const newProducts = data.products.filter((product) => !state.knownProductIds.has(product.id));
      const currentProductIds = new Set(data.products.map((product) => product.id));
      const removedProducts = [...state.knownProductIds]
        .filter((id) => !currentProductIds.has(id))
        .map((id) => ({ id, name: state.knownProductNames.get(id) || id }));
      let updates = 0;
      let newOrderAlerts = 0;
      newOrders.forEach((order) => {
        state.knownOrderRefs.add(order.ref);
        const orderAlert = addActivityNotification('order:' + order.ref, 'New order received', 'Order ' + order.ref + ' is ready to review.', 'orders');
        updates += orderAlert;
        newOrderAlerts += orderAlert;
        const customerKey = customerKeyForOrder(order);
        if (customerKey && !state.knownCustomerKeys.has(customerKey)) {
          state.knownCustomerKeys.add(customerKey);
          updates += addActivityNotification('customer:' + customerKey, 'New customer', (order.customer.name || 'A customer') + ' placed their first order.', 'customers');
        }
        if (isPaidOrder(order)) {
          updates += addActivityNotification('report:order:' + order.ref, 'New sale recorded', 'Order ' + order.ref + ' added ' + money(order.subtotal) + ' to sales.', 'reports');
        }
      });
      newProducts.forEach((product) => {
        state.knownProductIds.add(product.id);
        state.knownProductNames.set(product.id, product.name);
        updates += addActivityNotification('product:' + product.id, 'Product added', product.name + ' was added to your store.', 'products');
      });
      removedProducts.forEach((product) => {
        state.knownProductIds.delete(product.id);
        state.knownInventorySignals.delete(product.id);
        state.knownProductNames.delete(product.id);
        updates += addActivityNotification('product-removed:' + product.id, 'Product removed', product.name + ' was removed from your store.', 'products');
      });
      data.orders.forEach((order) => {
        const previousStatus = state.knownOrderStatuses.get(order.ref);
        if (previousStatus && previousStatus !== order.status) {
          updates += addActivityNotification(
            'order-status:' + order.ref + ':' + order.status,
            'Order status updated',
            'Order ' + order.ref + ' is now ' + statusLabel(order.status) + '.',
            'orders'
          );
          if (!isPaidStatus(previousStatus) && isPaidOrder(order)) {
            updates += addActivityNotification(
              'report:order:' + order.ref,
              'New sale recorded',
              'Order ' + order.ref + ' added ' + money(order.subtotal) + ' to sales.',
              'reports'
            );
          }
        }
        state.knownOrderStatuses.set(order.ref, order.status);
      });
      data.products.forEach((product) => {
        const nextSignal = inventorySignal(product);
        const previousSignal = state.knownInventorySignals.get(product.id);
        if (previousSignal && previousSignal !== nextSignal
          && (previousSignal === 'low' || previousSignal === 'out' || nextSignal === 'low' || nextSignal === 'out')) {
          const message = nextSignal === 'out'
            ? product.name + ' is out of stock.'
            : nextSignal === 'low'
              ? product.name + ' is running low' + (Number.isInteger(product.stock) ? ' (' + product.stock + ' left).' : '.')
              : product.name + ' has been restocked.';
          updates += addActivityNotification(
            'inventory:' + product.id + ':' + nextSignal + ':' + String(product.stock),
            nextSignal === 'normal' ? 'Inventory restocked' : 'Inventory needs attention',
            message,
            'inventory'
          );
        }
        state.knownInventorySignals.set(product.id, nextSignal);
        state.knownProductNames.set(product.id, product.name);
        if (newProducts.includes(product) && (nextSignal === 'low' || nextSignal === 'out')) {
          updates += addActivityNotification(
            'inventory:' + product.id + ':' + nextSignal + ':' + String(product.stock),
            'Inventory needs attention',
            product.name + (nextSignal === 'out' ? ' is out of stock.' : ' is running low.'),
            'inventory'
          );
        }
      });
      state.products = data.products;
      state.orders = data.orders;
      state.categories = data.categories;
      state.store = data.store;
      state.pollErrorNotified = false;
      saveNotificationSnapshot();
      if (newOrderAlerts) playNewOrderSound();
      if (updates) {
        const notificationWrapper = $('.admin-notifications');
        if (notificationWrapper) {
          if (state.notificationOpen) renderNotificationPanel(notificationWrapper);
          else syncNotificationButton(notificationWrapper);
        }
        syncSidebarIndicators();
        const content = $('#adminContent');
        if (content) content.replaceChildren(renderPage());
        const parts = [];
        if (newOrders.length) parts.push(newOrders.length + (newOrders.length === 1 ? ' new order' : ' new orders'));
        if (newProducts.length) parts.push(newProducts.length + (newProducts.length === 1 ? ' product added' : ' products added'));
        toast(parts.length ? parts.join(' · ') : 'You have new dashboard notifications.');
      }
      return true;
    } catch (error) {
      if (!state.pollErrorNotified && state.email) {
        state.pollErrorNotified = true;
        if (root.querySelector('.admin-shell')) toast('Live updates paused: ' + error.message, true);
      }
      return false;
    } finally {
      state.pollRunning = false;
    }
  }

  const pageInfo = {
    overview: ['Overview', 'Here’s what’s happening with your store today.'],
    performance: ['Store performance', 'Understand visits, sales, and the products customers buy most.'],
    orders: ['Orders', 'Review purchases and keep every order moving.'],
    products: ['Products', 'Manage the products customers see in your store.'],
    inventory: ['Inventory', 'Keep stock levels and availability up to date.'],
    customers: ['Customers', 'Get to know the people shopping with you.'],
    reports: ['Sales reports', 'Understand your sales and revenue over time.']
  };
  const navItems = [
    ['overview', 'Overview', 'grid'], ['orders', 'Orders', 'truck'],
    ['performance', 'Store performance', 'chart'],
    ['products', 'Products', 'bag'], ['inventory', 'Inventory', 'chart'],
    ['customers', 'Customers', 'people'], ['reports', 'Sales reports', 'chart']
  ];

  function renderShell() {
    const current = pageInfo[state.page] || pageInfo.overview;
    const sidebar = h('aside', { class: 'admin-sidebar', id: 'adminSidebar' },
      h('a', { class: 'brand', href: '/', 'aria-label': "Le-Gacy's Importation storefront" },
        h('img', { class: 'brand-logo', src: '/legacys-logo.svg', alt: '' })),
      h('nav', { 'aria-label': 'Admin navigation' },
        h('p', { class: 'admin-nav-label', text: 'Store management' }),
        navItems.map(([id, label, iconName]) => {
          const unread = sectionHasUnread(id);
          return h('button', {
          class: 'admin-nav' + (id === state.page ? ' active' : ''), type: 'button',
          'aria-current': id === state.page ? 'page' : null,
          'aria-label': unread ? label + ', unread updates' : null,
          'data-section': id,
          'data-label': label,
          onclick: () => navigateToPage(id)
          }, icon(iconName), h('span', { text: label }),
          unread ? h('span', { class: 'admin-nav-indicator', 'aria-hidden': 'true' }) : null);
        })),
      h('div', { class: 'admin-side-bottom' },
        h('a', { class: 'admin-nav', href: '/', target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: 'View storefront' })),
        h('div', { class: 'admin-profile' },
          h('span', { class: 'admin-avatar', text: 'A' }),
          h('span', { class: 'admin-profile-copy' }, h('strong', { text: 'Store admin' }), h('span', { text: state.email }))),
        h('button', { class: 'btn btn-ghost btn-sm admin-logout', type: 'button', onclick: signOut, text: 'Sign out' })));
    const topbar = h('header', { class: 'admin-topbar' },
      h('div', { class: 'admin-top-left' },
        h('button', { class: 'admin-icon-btn admin-mobile-toggle', type: 'button', 'aria-label': 'Open navigation', onclick: toggleSidebar }, icon('menu')),
        h('div', {}, h('h1', { text: current[0] }), h('p', { text: current[1] }))),
      h('div', { class: 'admin-actions' },
        notificationControl(),
        h('button', { class: 'admin-sound-toggle', type: 'button', onclick: toggleDashboardSound }),
        h('button', { class: 'admin-icon-btn', type: 'button', 'aria-label': 'Refresh dashboard', title: 'Refresh data', onclick: refreshData }, icon('refresh')),
        h('a', { class: 'btn btn-ghost btn-sm', href: '/', target: '_blank', rel: 'noopener noreferrer', text: 'View store' })));
    const content = h('section', { class: 'admin-content', id: 'adminContent' });
    content.append(renderPage());
    root.replaceChildren(h('div', { class: 'admin-shell' }, sidebar, h('div', { class: 'admin-main' }, topbar, content)));
    syncSoundControl();
  }

  function notificationControl() {
    const wrapper = h('div', { class: 'admin-notifications' });
    const count = unreadNotificationCount();
    const button = h('button', {
      class: 'admin-icon-btn admin-notification-button' + (count ? ' has-unread' : ''),
      type: 'button',
      'aria-label': count ? 'Notifications, ' + count + ' unread' : 'Notifications',
      'aria-expanded': String(state.notificationOpen),
      title: 'Notifications',
      onclick: () => {
        state.notificationOpen = !state.notificationOpen;
        renderNotificationPanel(wrapper);
      }
    }, icon('bell', 18), count ? h('span', { class: 'admin-notification-count', text: count > 99 ? '99+' : String(count) }) : null);
    wrapper.append(button);
    syncNotificationButton(wrapper);
    if (state.notificationOpen) renderNotificationPanel(wrapper);
    return wrapper;
  }

  function syncNotificationButton(wrapper) {
    const button = $('.admin-notification-button', wrapper);
    const count = unreadNotificationCount();
    if (button) {
      button.setAttribute('aria-expanded', String(state.notificationOpen));
      button.setAttribute('aria-label', count ? 'Notifications, ' + count + ' unread' : 'Notifications');
      button.classList.toggle('has-unread', count > 0);
      button.querySelector('.admin-notification-count')?.remove();
      if (count) button.append(h('span', { class: 'admin-notification-count', text: count > 99 ? '99+' : String(count) }));
    }
  }

  function renderNotificationPanel(wrapper) {
    wrapper.querySelector('.admin-notification-panel')?.remove();
    syncNotificationButton(wrapper);
    const count = unreadNotificationCount();
    if (!state.notificationOpen) return;
    const panel = h('section', { class: 'admin-notification-panel', 'aria-label': 'Notifications' },
      h('div', { class: 'admin-notification-head' },
        h('div', {}, h('strong', { text: 'Notifications' }), h('span', { class: 'admin-notification-summary', text: count ? count + ' unread' : 'You’re all caught up' })),
        count ? h('button', { class: 'admin-notification-action', type: 'button', onclick: markAllNotificationsRead, text: 'Mark all read' }) : null),
      state.notifications.length
        ? h('div', { class: 'admin-notification-list' }, state.notifications.slice(0, 20).map((item) =>
          h('button', {
            class: 'admin-notification-item' + (item.read ? '' : ' unread'),
            type: 'button',
            onclick: () => openNotification(item.id)
          },
          h('span', { class: 'admin-notification-dot ' + (item.type === 'product' ? 'product' : 'order') }),
          h('span', { class: 'admin-notification-copy' },
            h('strong', { text: item.title }),
            h('span', { text: item.message }),
            h('time', { datetime: item.createdAt, text: notificationTime(item.createdAt) })))))
        : h('div', { class: 'admin-notification-empty', text: 'New orders and products will show up here.' }));
    wrapper.append(panel);
  }

  function markAllNotificationsRead() {
    state.notifications.forEach((item) => { item.read = true; });
    saveNotifications();
    syncSidebarIndicators();
    const wrapper = $('.admin-notifications');
    if (wrapper) renderNotificationPanel(wrapper);
  }

  function openNotification(id) {
    const item = state.notifications.find((notification) => notification.id === id);
    if (!item) return;
    item.read = true;
    saveNotifications();
    state.notificationOpen = false;
    const section = notificationSection(item.type);
    state.page = pageInfo[section] ? section : 'overview';
    state.filter = '';
    renderShell();
  }

  function toggleSidebar() {
    const sidebar = $('#adminSidebar');
    if (sidebar) sidebar.classList.toggle('open');
  }

  async function refreshData() {
    try {
      if (state.pollRunning) {
        toast('The dashboard is already refreshing.');
        return;
      }
      const refreshed = await pollForChanges();
      if (!refreshed) return;
      if (state.page === 'performance') await loadAnalytics();
      renderShell();
      toast('Dashboard data refreshed.');
    } catch (error) { toast(error.message, true); }
  }

  function pageHeader(title, description, action) {
    return h('div', { class: 'admin-content-head' },
      h('div', {}, h('h2', { text: title }), h('p', { text: description })),
      action || null);
  }

  function metric(label, value, note, iconName) {
    return h('article', { class: 'admin-metric' },
      h('div', { class: 'admin-metric-top' }, h('span', { text: label }), h('span', { class: 'admin-metric-icon' }, icon(iconName))),
      h('strong', { text: value }), h('p', { class: 'admin-metric-note', text: note }));
  }

  function paidOrders() {
    return state.orders.filter((order) => ['confirmed', 'processing', 'dispatched', 'delivered'].includes(order.status));
  }

  function revenue(orders = paidOrders()) {
    return orders.reduce((total, order) => total + Number(order.subtotal || 0), 0);
  }

  function renderPage() {
    switch (state.page) {
      case 'performance': return renderPerformance();
      case 'orders': return renderOrders();
      case 'products': return renderProducts();
      case 'inventory': return renderInventory();
      case 'customers': return renderCustomers();
      case 'reports': return renderReports();
      default: return renderOverview();
    }
  }

  function renderOverview() {
    const allRevenue = revenue();
    const awaiting = state.orders.filter((order) => ['awaiting_payment', 'payment_submitted'].includes(order.status)).length;
    const customers = customerRecords();
    const last7 = paidOrders().filter((order) => Date.parse(order.createdAt) >= Date.now() - 7 * 86400000);
    const head = pageHeader('Store overview', 'A quick snapshot of your store’s performance.',
      h('button', { class: 'btn', type: 'button', onclick: () => { state.page = 'products'; renderShell(); openProductModal(); } }, icon('plus', 16), h('span', { text: 'Add product' })));
    const metrics = h('div', { class: 'admin-metrics' },
      metric('Total revenue', money(allRevenue), 'From confirmed and fulfilled orders', 'chart'),
      metric('Total orders', String(state.orders.length), awaiting + ' awaiting attention', 'truck'),
      metric('Products', String(state.products.length), state.products.filter((product) => product.inStock).length + ' currently available', 'bag'),
      metric('Customers', String(customers.length), last7.length + ' paid orders in the last 7 days', 'people'));
    const chart = h('div', { class: 'admin-card' },
      h('div', { class: 'admin-card-head' }, h('div', {}, h('h3', { text: 'Revenue trend' }), h('p', { text: 'Paid orders · last 7 days' })),
        h('button', { class: 'link', type: 'button', onclick: () => { state.page = 'reports'; renderShell(); }, text: 'View report' })),
      revenueChart(7));
    const statusCounts = [
      ['Pending', state.orders.filter((order) => ['awaiting_payment', 'payment_submitted'].includes(order.status)).length],
      ['Confirmed', state.orders.filter((order) => order.status === 'confirmed').length],
      ['Processing', state.orders.filter((order) => order.status === 'processing').length],
      ['Shipped', state.orders.filter((order) => order.status === 'dispatched').length],
      ['Delivered', state.orders.filter((order) => order.status === 'delivered').length]
    ];
    const maxStatus = Math.max(1, ...statusCounts.map(([, count]) => count));
    const statusCard = h('div', { class: 'admin-card' },
      h('div', { class: 'admin-card-head' }, h('div', {}, h('h3', { text: 'Order status' }), h('p', { text: 'Current order pipeline' }))),
      h('div', { class: 'admin-status-list' }, statusCounts.map(([label, count]) =>
        h('div', { class: 'admin-status-row' },
          h('span', { text: label }), h('div', { class: 'admin-status-track' },
            h('div', { class: 'admin-status-fill', style: 'width:' + (count / maxStatus * 100) + '%' })),
          h('strong', { text: String(count) })))));
    const recent = h('div', { class: 'admin-card admin-section-gap' },
      h('div', { class: 'admin-card-head' },
        h('div', {}, h('h3', { text: 'Recent orders' }), h('p', { text: 'The latest customer activity' })),
        h('button', { class: 'link', type: 'button', onclick: () => { state.page = 'orders'; renderShell(); }, text: 'All orders' })),
      orderTable(state.orders.slice(0, 5), false));
    return h('div', {}, head, metrics, h('div', { class: 'admin-grid-2' }, chart, statusCard), recent);
  }

  function renderPerformance() {
    const range = h('select', {
      class: 'select admin-range',
      'aria-label': 'Store performance date range',
      onchange: (event) => changeAnalyticsRange(Number(event.target.value))
    }, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']]
      .map(([value, label]) => h('option', { value, text: label, selected: state.analyticsDays === value })));
    const head = pageHeader('Store performance', 'See how many people visit and what customers buy.', range);
    if (state.analyticsLoading && !state.analytics) {
      return h('div', {}, head,
        h('div', { class: 'admin-card admin-performance-loading', 'aria-live': 'polite', text: 'Loading store performance…' }));
    }
    if (state.analyticsError && !state.analytics) {
      return h('div', {}, head,
        h('div', { class: 'admin-card admin-performance-loading' },
          h('p', { class: 'admin-error-text', text: 'Store performance could not be loaded: ' + state.analyticsError }),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => changeAnalyticsRange(state.analyticsDays), text: 'Try again' })));
    }
    const data = state.analytics || {
      days: state.analyticsDays, pageViews: 0, uniqueVisitors: 0, paidOrders: 0, itemsSold: 0, revenue: 0, daily: [], topProducts: []
    };
    const metrics = h('div', { class: 'admin-metrics' },
      metric('Visitors', Number(data.uniqueVisitors).toLocaleString(), 'Estimated unique browsers in this period', 'people'),
      metric('Page views', Number(data.pageViews).toLocaleString(), 'Store pages viewed in this period', 'chart'),
      metric('Paid orders', Number(data.paidOrders).toLocaleString(), 'Orders confirmed or fulfilled', 'truck'),
      metric('Sales revenue', money(data.revenue), 'From confirmed and fulfilled orders', 'bag'));
    const views = data.daily || [];
    const peakViews = Math.max(...views.map((day) => day.pageViews), 1);
    const labelEvery = data.days <= 7 ? 1 : data.days <= 30 ? 5 : 15;
    const trafficChart = h('div', { class: 'admin-card' },
      h('div', { class: 'admin-card-head' },
        h('div', {}, h('h3', { text: 'Store visits' }), h('p', { text: 'Page views per day · last ' + data.days + ' days' })),
        state.analyticsLoading && h('span', { class: 'admin-live-label', text: 'Updating…' })),
      views.some((day) => day.pageViews)
        ? h('div', { class: 'admin-traffic-scroll', tabindex: '0', 'aria-label': 'Daily page view chart' },
          h('div', { class: 'admin-traffic-bars', role: 'img', 'aria-label': 'Daily store page views', style: 'grid-template-columns:repeat(' + views.length + ',minmax(24px,1fr))' },
            views.map((day, index) => {
              const date = new Date(day.date + 'T00:00:00Z');
              const label = index % labelEvery === 0 || index === views.length - 1
                ? date.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
                : '';
              return h('div', { class: 'admin-traffic-day', title: label + ': ' + day.pageViews + ' page views, ' + day.visitors + ' visitors' },
                h('span', { class: 'admin-traffic-value', text: day.pageViews ? String(day.pageViews) : '' }),
                h('div', { class: 'admin-traffic-track' },
                  h('span', { class: 'admin-traffic-bar', style: 'height:' + (day.pageViews ? Math.max(4, day.pageViews / peakViews * 100) : 0) + '%' })),
                h('span', { class: 'admin-traffic-date', text: label }));
            })))
        : h('div', { class: 'admin-chart-empty', text: 'Store visit data will appear here as customers browse.' }),
      h('p', { class: 'admin-privacy-note', text: 'Visitor counts are anonymous estimates based on browser storage. One person may count as more than one visitor on different devices. Tracking begins with this update.' }));
    const products = data.topProducts || [];
    const productRows = products.map((item, index) =>
      h('tr', {},
        h('td', {}, h('div', { class: 'admin-ranked-product' },
          h('span', { class: 'admin-rank', text: String(index + 1).padStart(2, '0') }),
          h('strong', { text: item.name }))),
        h('td', { text: item.category ? categoryName(item.category) : '—' }),
        h('td', { text: Number(item.quantity).toLocaleString() }),
        h('td', { text: money(item.revenue) })));
    const productTable = products.length
      ? h('div', { class: 'admin-table-wrap' },
        h('table', { class: 'admin-table' },
          h('thead', {}, h('tr', {}, ['Product', 'Category', 'Quantity sold', 'Sales'].map((label) => h('th', { text: label })))),
          h('tbody', {}, productRows)))
      : h('div', { class: 'admin-empty admin-product-empty' },
        h('strong', { text: 'No paid purchases in this period yet' }),
        h('span', { text: 'Popular products will appear here after orders are confirmed.' }));
    const bestSellers = h('div', { class: 'admin-card admin-section-gap' },
      h('div', { class: 'admin-card-head' },
        h('div', {}, h('h3', { text: 'What customers buy most' }), h('p', { text: 'Ranked by quantity in paid orders · ' + data.itemsSold + ' items sold' })),
        state.analyticsLoading && h('span', { class: 'admin-live-label', text: 'Updating…' })),
      productTable);
    return h('div', {}, head, metrics, trafficChart, bestSellers);
  }

  function revenueChart(days) {
    const series = revenueSeries(days);
    const max = Math.max(...series.map((item) => item.total), 1);
    if (!series.some((item) => item.total > 0)) {
      return h('div', { class: 'admin-chart-empty', text: 'Revenue will appear here as orders are confirmed.' });
    }
    const width = 620, height = 180, pad = 12;
    const points = series.map((item, index) => {
      const x = pad + index * (width - 2 * pad) / Math.max(1, series.length - 1);
      const y = height - pad - item.total / max * (height - 2 * pad);
      return [x, y];
    });
    const line = points.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Revenue over the last ' + days + ' days');
    [0, 1, 2, 3].forEach((row) => {
      const y = pad + row * (height - 2 * pad) / 3;
      const gridline = document.createElementNS(svg.namespaceURI, 'path');
      gridline.setAttribute('d', 'M' + pad + ' ' + y + 'H' + (width - pad));
      gridline.setAttribute('stroke', '#efedf4');
      gridline.setAttribute('stroke-dasharray', '3 5');
      svg.append(gridline);
    });
    const fill = document.createElementNS(svg.namespaceURI, 'path');
    fill.setAttribute('d', line + ' L' + points[points.length - 1][0] + ' ' + (height - pad) + ' L' + points[0][0] + ' ' + (height - pad) + ' Z');
    fill.setAttribute('fill', 'rgba(124,93,217,.10)');
    svg.append(fill);
    const stroke = document.createElementNS(svg.namespaceURI, 'path');
    stroke.setAttribute('d', line);
    stroke.setAttribute('fill', 'none');
    stroke.setAttribute('stroke', '#7c5dd9');
    stroke.setAttribute('stroke-width', '3');
    stroke.setAttribute('stroke-linecap', 'round');
    stroke.setAttribute('stroke-linejoin', 'round');
    svg.append(stroke);
    points.forEach(([x, y]) => {
      const circle = document.createElementNS(svg.namespaceURI, 'circle');
      circle.setAttribute('cx', String(x)); circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '3.5'); circle.setAttribute('fill', '#fff');
      circle.setAttribute('stroke', '#7c5dd9'); circle.setAttribute('stroke-width', '2');
      svg.append(circle);
    });
    return h('div', { class: 'admin-chart' }, svg,
      h('div', { class: 'admin-chart-labels' }, h('span', { text: series[0].label }), h('span', { text: series[Math.floor(series.length / 2)].label }), h('span', { text: series[series.length - 1].label })));
  }

  function revenueSeries(days) {
    const data = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - offset);
      const key = day.toDateString();
      data.push({
        key, label: days <= 7
          ? day.toLocaleDateString('en', { weekday: 'short' })
          : day.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
        total: paidOrders().filter((order) => new Date(order.createdAt).toDateString() === key)
          .reduce((sum, order) => sum + Number(order.subtotal || 0), 0)
      });
    }
    return data;
  }

  function renderOrders() {
    const filters = h('select', { class: 'select', 'aria-label': 'Filter orders', onchange: (event) => { state.filter = event.target.value; renderShell(); } },
      [['', 'All orders'], ['awaiting_payment', 'Pending'], ['payment_submitted', 'Payment review'], ['confirmed', 'Confirmed'], ['processing', 'Processing your order'], ['dispatched', 'On the way'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']]
        .map(([value, label]) => h('option', { value, text: label, selected: state.filter === value })));
    const search = h('div', { class: 'search' }, icon('search', 16),
      h('input', { class: 'input', type: 'search', placeholder: 'Search order or customer', 'aria-label': 'Search orders', oninput: (event) => filterTable(event.target.value, '#ordersTable') }));
    return h('div', {}, pageHeader('Orders', 'Update an order to “Processing your order”, “On the way” or “Delivered” to show customers their progress on Track order.'),
      h('div', { class: 'admin-toolbar' }, search, filters),
      h('div', { id: 'ordersTable' }, orderTable(state.orders.filter((order) => !state.filter || order.status === state.filter), true)));
  }

  function orderStatus(order) {
    if (order.status === 'awaiting_payment') return ['Pending', 'amber'];
    if (order.status === 'payment_submitted') return ['Payment review', 'amber'];
    if (order.status === 'confirmed') return ['Confirmed', 'purple'];
    if (order.status === 'processing') return ['Processing your order', 'purple'];
    if (order.status === 'dispatched') return ['On the way', 'green'];
    if (order.status === 'delivered') return ['Delivered', 'green'];
    return ['Cancelled', 'red'];
  }

  function orderTable(orders, editable) {
    if (!orders.length) return h('div', { class: 'admin-table-wrap' }, h('div', { class: 'admin-empty' }, h('strong', { text: 'No orders to show' }), h('span', { text: 'New orders will appear here.' })));
    return h('div', { class: 'admin-table-wrap' },
      h('table', { class: 'admin-table' },
        h('thead', {}, h('tr', {},
          ['Order', 'Customer', 'Date', 'Items', 'Total', 'Status', ...(editable ? ['Update status'] : [])].map((label) => h('th', { text: label })))),
        h('tbody', {}, orders.map((order) => {
          const [label, tone] = orderStatus(order);
          const customer = order.customer || {};
          const productsText = (order.items || []).map((item) => item.qty + ' × ' + item.name).join(', ');
          const statusSelect = h('select', { class: 'select', 'aria-label': 'Update status for ' + order.ref, onchange: (event) => updateOrderStatus(order, event.target) },
            [['awaiting_payment', 'Pending'], ['payment_submitted', 'Payment review'], ['confirmed', 'Payment confirmed'], ['processing', 'Processing your order'], ['dispatched', 'On the way'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']]
              .map(([value, text]) => h('option', { value, selected: order.status === value, text })));
          return h('tr', { 'data-search': [order.ref, customer.name, customer.phone, customer.email].join(' ').toLowerCase() },
            h('td', {}, h('span', { class: 'admin-order-ref', text: order.ref })),
            h('td', {}, h('strong', { text: customer.name || 'Customer' }), h('div', { class: 'small muted', text: customer.phone || customer.email || '' })),
            h('td', { text: new Date(order.createdAt).toLocaleString('en-GH', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }),
            h('td', {}, h('span', { class: 'admin-order-items', text: productsText })),
            h('td', { text: money(order.subtotal) }),
            h('td', {}, h('span', { class: 'admin-pill ' + tone, text: label })),
            editable ? h('td', {}, statusSelect) : null);
        }))));
  }

  async function updateOrderStatus(order, select) {
    const previous = order.status;
    select.disabled = true;
    try {
      const result = await request('/api/admin/status', { ref: order.ref, status: select.value });
      order.status = result.order.status;
      order.updatedAt = result.order.updatedAt;
      state.knownOrderStatuses.set(order.ref, order.status);
      saveNotificationSnapshot();
      if (previous !== order.status) {
        addActivityNotification(
          'order-status:' + order.ref + ':' + order.status,
          'Order status updated',
          'Order ' + order.ref + ' is now ' + statusLabel(order.status) + '.',
          'orders'
        );
        if (!isPaidStatus(previous) && isPaidOrder(order)) {
          addActivityNotification(
            'report:order:' + order.ref,
            'New sale recorded',
            'Order ' + order.ref + ' added ' + money(order.subtotal) + ' to sales.',
            'reports'
          );
        }
      }
      toast('Order ' + order.ref + ' updated.');
      renderShell();
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      toast(error.message, true);
    }
  }

  function productThumb(product, size = '') {
    const image = product.image && (/^\/(?:uploads|images)\//.test(product.image) || /^https:\/\//i.test(product.image))
      ? h('img', { src: product.image, alt: '', loading: 'lazy' }) : icon('image', 20);
    return h('span', { class: 'admin-product-thumb' + (size ? ' ' + size : '') }, image);
  }

  function productStatus(product) {
    if (product.preOrder && !product.inStock) return ['Pre-order', 'purple'];
    if (product.inStock) return ['Available', 'green'];
    return ['Out of stock', 'red'];
  }

  function productTable(products) {
    if (!products.length) return h('div', { class: 'admin-table-wrap' }, h('div', { class: 'admin-empty' }, h('strong', { text: 'No products found' }), h('span', { text: 'Add a product to get started.' })));
    return h('div', { class: 'admin-table-wrap' }, h('table', { class: 'admin-table' },
      h('thead', {}, h('tr', {}, ['Product', 'Category', 'Price', 'Stock', 'Availability', 'Actions'].map((label) => h('th', { text: label })))),
      h('tbody', {}, products.map((product) => {
        const [label, tone] = productStatus(product);
        return h('tr', { 'data-search': [product.name, product.category, label].join(' ').toLowerCase() },
          h('td', {}, h('div', { class: 'admin-product' }, productThumb(product),
            h('div', {}, h('strong', { text: product.name }), h('span', { text: product.id })))),
          h('td', { text: categoryName(product.category) }),
          h('td', { text: money(product.price) }),
          h('td', { text: Number.isInteger(product.stock) ? String(product.stock) : '—' }),
          h('td', {}, h('span', { class: 'admin-pill ' + tone, text: label })),
          h('td', {}, h('div', { class: 'admin-actions-cell' },
            h('button', { class: 'admin-icon-btn', type: 'button', title: 'Edit product', 'aria-label': 'Edit ' + product.name, onclick: () => openProductModal(product) }, icon('edit', 15)),
            h('button', { class: 'admin-icon-btn', type: 'button', title: 'Remove product', 'aria-label': 'Remove ' + product.name, onclick: () => removeProduct(product) }, icon('trash', 15)))));
      }))));
  }

  function renderProducts() {
    const action = h('div', { class: 'admin-actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: openBatchImportModal }, h('span', { text: 'Batch upload' })),
      h('a', { class: 'btn btn-ghost', href: '/product-import-template.csv', download: 'product-import-template.csv' }, h('span', { text: 'Download template' })),
      h('button', { class: 'btn', type: 'button', onclick: () => openProductModal() }, icon('plus', 16), h('span', { text: 'Add product' })));
    const search = h('div', { class: 'search' }, icon('search', 16),
      h('input', { class: 'input', type: 'search', placeholder: 'Search products', 'aria-label': 'Search products', oninput: (event) => filterTable(event.target.value, '#productsTable') }));
    return h('div', {}, pageHeader('Products', 'Add, edit, publish, or import up to 500 products from an Excel or CSV file.', action),
      h('div', { class: 'admin-toolbar' }, search,
        h('span', { class: 'small muted', text: state.products.length + ' products' })),
      h('div', { id: 'productsTable' }, productTable(state.products)));
  }

  function renderInventory() {
    const rows = state.products;
    const lowStock = rows.filter((product) => Number.isInteger(product.stock) && product.stock <= 5 && product.stock > 0).length;
    const outOfStock = rows.filter((product) => !product.inStock).length;
    const table = rows.length ? h('div', { class: 'admin-table-wrap' }, h('table', { class: 'admin-table' },
      h('thead', {}, h('tr', {}, ['Product', 'Availability', 'Quantity in stock', 'Quick action'].map((label) => h('th', { text: label })))),
      h('tbody', {}, rows.map((product) => {
        const quantity = h('input', { class: 'input', type: 'number', min: '0', max: '1000000', value: product.stock == null ? '' : product.stock, placeholder: 'Not tracked', 'aria-label': 'Stock count for ' + product.name, style: 'width:110px;padding:7px 9px' });
        const available = h('select', { class: 'select', 'aria-label': 'Availability for ' + product.name, style: 'width:145px' },
          [['true', 'Available'], ['false', product.preOrder ? 'Pre-order only' : 'Unavailable']]
            .map(([value, label]) => h('option', { value, text: label, selected: String(product.inStock) === value })));
        const save = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Save' });
        save.addEventListener('click', () => saveInventory(product, quantity, available, save));
        return h('tr', {},
          h('td', {}, h('div', { class: 'admin-product' }, productThumb(product),
            h('div', {}, h('strong', { text: product.name }), h('span', { text: product.id })))),
          h('td', {}, h('span', { class: 'admin-pill ' + (product.inStock ? 'green' : product.preOrder ? 'purple' : 'red'), text: product.inStock ? 'Available' : product.preOrder ? 'Pre-order' : 'Unavailable' })),
          h('td', {}, quantity),
          h('td', {}, h('div', { class: 'admin-actions-cell' }, available, save)));
      })))) : h('div', { class: 'admin-table-wrap' }, h('div', { class: 'admin-empty', text: 'Add products to start tracking inventory.' }));
    const action = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { state.page = 'products'; renderShell(); } }, h('span', { text: 'Manage products' }));
    return h('div', {}, pageHeader('Inventory', 'Adjust stock counts and product availability.', action),
      h('div', { class: 'admin-metrics' },
        metric('Tracked products', String(rows.filter((product) => Number.isInteger(product.stock)).length), 'Products with a stock quantity set', 'bag'),
        metric('Low stock', String(lowStock), 'Five units or fewer remaining', 'chart'),
        metric('Out of stock', String(outOfStock), 'Hidden from purchase unless pre-order', 'truck'),
        metric('Total products', String(rows.length), 'Across all store categories', 'grid')),
      table);
  }

  async function saveInventory(product, quantityInput, availabilityInput, button) {
    const stock = quantityInput.value.trim() === '' ? null : Number(quantityInput.value);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1000000)) {
      toast('Enter a whole stock quantity between 0 and 1,000,000.', true);
      return;
    }
    button.disabled = true;
    try {
      const result = await request('/api/admin/products', Object.assign({}, product, {
        stock, inStock: availabilityInput.value === 'true'
      }));
      const oldSignal = inventorySignal(product);
      Object.assign(product, result.product);
      state.knownProductIds.add(product.id);
      const newSignal = inventorySignal(product);
      state.knownInventorySignals.set(product.id, newSignal);
      state.knownProductNames.set(product.id, product.name);
      saveNotificationSnapshot();
      if (oldSignal !== newSignal
        && (oldSignal === 'low' || oldSignal === 'out' || newSignal === 'low' || newSignal === 'out')) {
        addActivityNotification(
          'inventory:' + product.id + ':' + newSignal + ':' + String(product.stock),
          newSignal === 'normal' ? 'Inventory restocked' : 'Inventory needs attention',
          product.name + (newSignal === 'out' ? ' is out of stock.' : newSignal === 'low' ? ' is running low.' : ' has been restocked.'),
          'inventory'
        );
      }
      toast('Inventory updated.');
      renderShell();
    } catch (error) { button.disabled = false; toast(error.message, true); }
  }

  function customerRecords() {
    const records = new Map();
    state.orders.forEach((order) => {
      const customer = order.customer || {};
      const key = customer.phone || customer.email || customer.name || order.ref;
      let record = records.get(key);
      if (!record) {
        record = { key, name: customer.name || 'Customer', phone: customer.phone || '', email: customer.email || '', town: customer.town || '', orders: 0, spent: 0, lastOrder: order.createdAt };
        records.set(key, record);
      }
      record.orders += 1;
      if (['confirmed', 'processing', 'dispatched', 'delivered'].includes(order.status)) record.spent += Number(order.subtotal || 0);
      if (Date.parse(order.createdAt) > Date.parse(record.lastOrder)) record.lastOrder = order.createdAt;
    });
    return [...records.values()].sort((a, b) => Date.parse(b.lastOrder) - Date.parse(a.lastOrder));
  }

  function renderCustomers() {
    const records = customerRecords();
    const table = records.length ? h('div', { class: 'admin-table-wrap' }, h('table', { class: 'admin-table' },
      h('thead', {}, h('tr', {}, ['Customer', 'Contact', 'Location', 'Orders', 'Revenue', 'Last order'].map((label) => h('th', { text: label })))),
      h('tbody', {}, records.map((customer) => h('tr', { 'data-search': [customer.name, customer.phone, customer.email, customer.town].join(' ').toLowerCase() },
        h('td', {}, h('div', { class: 'admin-customer-name' }, h('span', { class: 'admin-avatar', text: initials(customer.name) }),
          h('strong', { text: customer.name }))),
        h('td', {}, h('span', { text: customer.phone }), h('div', { class: 'small muted', text: customer.email })),
        h('td', { text: customer.town || '—' }),
        h('td', { text: String(customer.orders) }),
        h('td', { text: money(customer.spent) }),
        h('td', { text: new Date(customer.lastOrder).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' }) })))))) :
      h('div', { class: 'admin-table-wrap' }, h('div', { class: 'admin-empty' }, h('strong', { text: 'No customers yet' }), h('span', { text: 'Customers appear after their first order.' })));
    return h('div', {}, pageHeader('Customers', 'A customer directory built from your order history.'),
      h('div', { class: 'admin-toolbar' },
        h('div', { class: 'search' }, icon('search', 16), h('input', { class: 'input', type: 'search', placeholder: 'Search customers', 'aria-label': 'Search customers', oninput: (event) => filterTable(event.target.value, '#customersTable') })),
        h('span', { class: 'small muted', text: records.length + ' customers' })),
      h('div', { id: 'customersTable' }, table));
  }

  function initials(name) {
    return String(name || 'A').split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
  }

  function renderReports() {
    const series = revenueSeries(state.range);
    const max = Math.max(1, ...series.map((item) => item.total));
    const chart = h('div', { class: 'admin-card' },
      h('div', { class: 'admin-card-head' }, h('div', {}, h('h3', { text: 'Revenue' }), h('p', { text: 'Paid orders by day' })),
        h('select', { class: 'select admin-range', 'aria-label': 'Report date range', onchange: (event) => { state.range = Number(event.target.value); renderShell(); } },
          [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']]
            .map(([value, label]) => h('option', { value, text: label, selected: state.range === value })))),
      h('div', { class: 'admin-bars' }, series.map((item) => h('div', { class: 'admin-bar-col', title: item.label + ': ' + money(item.total) },
        h('div', { class: 'admin-bar-track' }, h('span', { class: 'admin-bar', style: 'height:' + Math.max(item.total ? 4 : 0, item.total / max * 100) + '%' })),
        h('span', { text: state.range <= 7 ? item.label : item.label.slice(item.label.indexOf(' ') + 1) })))),
      h('p', { class: 'small muted', style: 'margin-top:12px', text: 'Revenue counts orders from Confirmed through Delivered. Pending and cancelled orders are excluded.' }));
    const paid = paidOrders();
    const topProducts = new Map();
    paid.forEach((order) => (order.items || []).forEach((item) => {
      const existing = topProducts.get(item.name) || { name: item.name, units: 0, revenue: 0 };
      existing.units += Number(item.qty || 0);
      existing.revenue += Number(item.price || 0) * Number(item.qty || 0);
      topProducts.set(item.name, existing);
    }));
    const best = [...topProducts.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const topTable = h('div', { class: 'admin-table-wrap' }, best.length ? h('table', { class: 'admin-table' },
      h('thead', {}, h('tr', {}, ['Product', 'Units sold', 'Revenue'].map((label) => h('th', { text: label })))),
      h('tbody', {}, best.map((item) => h('tr', {}, h('td', { text: item.name }), h('td', { text: String(item.units) }), h('td', { text: money(item.revenue) })))))
      : h('div', { class: 'admin-empty', text: 'Product sales will appear after orders are confirmed.' }));
    const completed = paid.filter((order) => order.status === 'delivered');
    const reportSummary = h('div', { class: 'admin-card' },
      h('div', { class: 'admin-card-head' }, h('div', {}, h('h3', { text: 'Sales summary' }), h('p', { text: 'All-time store totals' }))),
      h('div', { class: 'admin-report-list' },
        reportRow('Gross revenue', money(revenue(paid))),
        reportRow('Paid orders', String(paid.length)),
        reportRow('Average order value', money(paid.length ? revenue(paid) / paid.length : 0)),
        reportRow('Delivered orders', String(completed.length)),
        reportRow('Pending orders', String(state.orders.filter((order) => ['awaiting_payment', 'payment_submitted'].includes(order.status)).length))));
    return h('div', {}, pageHeader('Sales reports', 'A clear picture of sales and what customers are buying.'),
      h('div', { class: 'admin-metrics' },
        metric('Revenue', money(revenue(paid)), 'Confirmed and fulfilled orders', 'chart'),
        metric('Paid orders', String(paid.length), 'Excludes unpaid and cancelled orders', 'truck'),
        metric('Average order', money(paid.length ? revenue(paid) / paid.length : 0), 'Revenue per paid order', 'bag'),
        metric('Delivered', String(completed.length), 'Orders marked delivered', 'people')),
      h('div', { class: 'admin-grid-2' }, chart, reportSummary),
      h('div', { class: 'admin-card admin-section-gap' },
        h('div', { class: 'admin-card-head' }, h('div', {}, h('h3', { text: 'Best-selling products' }), h('p', { text: 'Ranked by revenue from paid orders' }))),
        topTable));
  }

  function reportRow(label, value) {
    return h('div', { class: 'admin-report-row' }, h('span', { text: label }), h('strong', { text: value }));
  }

  function categoryName(id) {
    const category = state.categories.find((item) => item.id === id);
    return category ? category.name : id;
  }

  function filterTable(value, selector) {
    const table = $(selector);
    if (!table) return;
    const query = value.trim().toLowerCase();
    table.querySelectorAll('tbody tr').forEach((row) => {
      row.hidden = query !== '' && !String(row.dataset.search || row.textContent).toLowerCase().includes(query);
    });
  }

  function openProductModal(product) {
    const current = product || { name: '', category: state.categories[0] && state.categories[0].id, price: '', description: '', image: '', inStock: true, preOrder: false, stock: null, sizes: [], colors: [] };
    let image = current.image || '';
    const preview = h('span', { class: 'admin-image-preview' }, image ? h('img', { src: image, alt: 'Product image preview' }) : icon('image', 22));
    const imageHint = h('p', { text: image ? 'Current image ready.' : 'JPG, PNG or WebP · up to 4 MB' });
    const file = h('input', { class: 'input', type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Upload product image' });
    file.addEventListener('change', () => {
      const selected = file.files && file.files[0];
      if (!selected) return;
      if (selected.size > 4 * 1024 * 1024) { file.value = ''; toast('Choose an image smaller than 4 MB.', true); return; }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) { file.value = ''; toast('Choose a JPG, PNG, or WebP image.', true); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.split(',')[1];
        if (!base64) { toast('The image could not be read.', true); return; }
        request('/api/admin/upload', { filename: selected.name, mime: selected.type, data: base64 })
          .then((response) => {
            image = response.image;
            preview.replaceChildren(h('img', { src: image, alt: 'Product image preview' }));
            imageHint.textContent = 'Image uploaded and ready.';
            toast('Product image uploaded.');
          }).catch((error) => toast(error.message, true));
      };
      reader.onerror = () => toast('The selected image could not be read.', true);
      reader.readAsDataURL(selected);
    });
    const form = h('form', { onsubmit: (event) => saveProduct(event, current, product, image, save) });
    const name = h('input', { class: 'input', name: 'name', required: true, maxlength: '100', value: current.name, placeholder: 'e.g. Wireless earbuds' });
    const category = h('select', { class: 'select', name: 'category', required: true },
      state.categories.map((item) => h('option', { value: item.id, text: item.name, selected: item.id === current.category })));
    const price = h('input', { class: 'input', name: 'price', type: 'number', min: '0.01', max: '1000000', step: '0.01', required: true, value: current.price });
    const stock = h('input', { class: 'input', name: 'stock', type: 'number', min: '0', max: '1000000', step: '1', value: current.stock == null ? '' : current.stock, placeholder: 'Optional' });
    const description = h('textarea', { class: 'textarea', name: 'description', maxlength: '500', placeholder: 'Describe this product for your customers' });
    description.value = current.description || '';
    const sizes = h('input', { class: 'input', name: 'sizes', maxlength: '200', value: (current.sizes || []).join(', '), placeholder: 'e.g. S, M, L, XL' });
    const colors = h('input', { class: 'input', name: 'colors', maxlength: '200', value: (current.colors || []).join(', '), placeholder: 'e.g. Black, White, Blue' });
    const available = h('input', { type: 'checkbox', name: 'inStock', checked: !!current.inStock });
    const preOrder = h('input', { type: 'checkbox', name: 'preOrder', checked: !!current.preOrder });
    const save = h('button', { class: 'btn', type: 'submit', text: product ? 'Save changes' : 'Add product' });
    form.append(
      h('div', { class: 'admin-form-grid' },
        field('Product name', name), field('Category', category),
        field('Price (GH₵)', price), field('Stock quantity', stock),
        field('Description', description, 'wide'),
        field('Sizes (comma separated)', sizes), field('Colors (comma separated)', colors),
        h('div', { class: 'field wide' }, h('label', { text: 'Product image' }),
          h('div', { class: 'admin-image-upload' }, preview, h('div', {}, file, imageHint))),
        h('label', { class: 'admin-check' }, available, h('span', { text: 'Available to buy now' })),
        h('label', { class: 'admin-check' }, preOrder, h('span', { text: 'Allow pre-orders' }))),
      h('div', { class: 'admin-modal-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal, text: 'Cancel' }), save));
    modalRoot.replaceChildren(h('div', { class: 'admin-modal-backdrop', onclick: (event) => { if (event.target === event.currentTarget) closeModal(); } },
      h('section', { class: 'admin-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'productModalTitle' },
        h('div', { class: 'admin-modal-head' }, h('div', {}, h('h2', { id: 'productModalTitle', text: product ? 'Edit product' : 'Add a product' }),
          h('p', { text: product ? 'Update your product details and storefront listing.' : 'Add a new product to your storefront.' })),
          h('button', { class: 'admin-icon-btn', type: 'button', 'aria-label': 'Close dialog', onclick: closeModal }, icon('close', 16))),
        form)));
    name.focus();
  }

  function field(label, control, extraClass = '') {
    if (!control.id && control.name) control.id = control.name;
    return h('div', { class: 'field' + (extraClass ? ' ' + extraClass : '') }, h('label', { for: control.id || '', text: label }), control);
  }

  async function saveProduct(event, current, original, image, button) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const splitList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    const body = {
      id: current.id,
      name: formData.get('name'),
      category: formData.get('category'),
      price: Number(formData.get('price')),
      stock: formData.get('stock') === '' ? null : Number(formData.get('stock')),
      description: formData.get('description'),
      image,
      inStock: formData.has('inStock'),
      preOrder: formData.has('preOrder'),
      sizes: splitList(formData.get('sizes')),
      colors: splitList(formData.get('colors'))
    };
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const response = await request('/api/admin/products', body);
      const index = state.products.findIndex((item) => item.id === response.product.id);
      if (index >= 0) {
        const previous = state.products[index];
        const oldSignal = inventorySignal(previous);
        state.products[index] = response.product;
        state.knownProductNames.set(response.product.id, response.product.name);
        const nextSignal = inventorySignal(response.product);
        state.knownInventorySignals.set(response.product.id, nextSignal);
        if (oldSignal !== nextSignal
          && (oldSignal === 'low' || oldSignal === 'out' || nextSignal === 'low' || nextSignal === 'out')) {
          addActivityNotification(
            'inventory:' + response.product.id + ':' + nextSignal + ':' + String(response.product.stock),
            nextSignal === 'normal' ? 'Inventory restocked' : 'Inventory needs attention',
            response.product.name + (nextSignal === 'out' ? ' is out of stock.' : nextSignal === 'low' ? ' is running low.' : ' has been restocked.'),
            'inventory'
          );
        }
      } else {
        state.products.unshift(response.product);
        state.knownProductIds.add(response.product.id);
        state.knownProductNames.set(response.product.id, response.product.name);
        const signal = inventorySignal(response.product);
        state.knownInventorySignals.set(response.product.id, signal);
        addActivityNotification('product:' + response.product.id, 'Product added', response.product.name + ' was added to your store.', 'products');
        if (signal === 'low' || signal === 'out') {
          addActivityNotification(
            'inventory:' + response.product.id + ':' + signal + ':' + String(response.product.stock),
            'Inventory needs attention',
            response.product.name + (signal === 'out' ? ' is out of stock.' : ' is running low.'),
            'inventory'
          );
        }
      }
      saveNotificationSnapshot();
      closeModal();
      renderShell();
      toast(original ? 'Product changes saved.' : 'Product added to your store.');
    } catch (error) {
      button.disabled = false;
      button.textContent = original ? 'Save changes' : 'Add product';
      toast(error.message, true);
    }
  }

  function removeProduct(product) {
    const no = h('button', { class: 'btn btn-ghost', type: 'button', text: 'No, keep product', onclick: closeModal });
    const yes = h('button', { class: 'btn btn-danger', type: 'button', text: 'Yes, delete', onclick: () => deleteProduct(product, yes) });
    modalRoot.replaceChildren(h('div', { class: 'admin-modal-backdrop', onclick: (event) => { if (event.target === event.currentTarget) closeModal(); } },
      h('section', { class: 'admin-modal admin-confirm-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'deleteProductTitle', 'aria-describedby': 'deleteProductMessage' },
        h('div', { class: 'admin-modal-head' }, h('div', {},
          h('h2', { id: 'deleteProductTitle', text: 'Delete product?' }),
          h('p', { id: 'deleteProductMessage', text: 'Are you sure you want to delete “' + product.name + '”? This removes it from the storefront. Existing order records will be kept.' }))),
        h('div', { class: 'admin-modal-actions' }, no, yes))));
    no.focus();
  }

  async function deleteProduct(product, button) {
    button.disabled = true;
    try {
      await request('/api/admin/products/delete', { id: product.id });
      state.products = state.products.filter((item) => item.id !== product.id);
      state.knownProductIds.delete(product.id);
      state.knownInventorySignals.delete(product.id);
      state.knownProductNames.delete(product.id);
      addActivityNotification('product-removed:' + product.id, 'Product removed', product.name + ' was removed from your store.', 'products');
      saveNotificationSnapshot();
      closeModal();
      renderShell();
      toast('Product removed.');
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  }

  function openBatchImportModal() {
    let payload = null;
    const selectedFile = h('input', { class: 'input', type: 'file', accept: '.xlsx,.csv', 'aria-label': 'Choose an Excel or CSV product file' });
    const feedback = h('div', { class: 'admin-import-feedback', 'aria-live': 'polite' });
    const previewButton = h('button', { class: 'btn btn-ghost', type: 'button', text: 'Validate and preview', disabled: true });
    const importButton = h('button', { class: 'btn', type: 'button', text: 'Import products', disabled: true });

    function showErrors(errors) {
      const shown = errors.slice(0, 50);
      feedback.replaceChildren(
        h('p', { class: 'admin-import-error-count', text: 'Found ' + errors.length + ' issue' + (errors.length === 1 ? '' : 's') + (errors.length > shown.length ? '; showing the first ' + shown.length + '.' : '.') }),
        h('ul', { class: 'admin-import-errors' }, shown.map((item) => h('li', { text: 'Row ' + item.row + ': ' + item.message }))));
    }

    async function readSelectedFile(file) {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a spreadsheet smaller than 5 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { fileName: file.name, data: btoa(binary) };
    }

    selectedFile.addEventListener('change', () => {
      payload = null;
      previewButton.disabled = !selectedFile.files || !selectedFile.files[0];
      importButton.disabled = true;
      feedback.replaceChildren();
    });

    previewButton.addEventListener('click', async () => {
      const file = selectedFile.files && selectedFile.files[0];
      if (!file) return;
      previewButton.disabled = true;
      previewButton.textContent = 'Checking file…';
      importButton.disabled = true;
      feedback.replaceChildren();
      try {
        payload = await readSelectedFile(file);
        const result = await request('/api/admin/products/import/preview', payload);
        if (!result.valid) {
          showErrors(result.errors || [{ row: 1, message: 'The spreadsheet is invalid.' }]);
          return;
        }
        const previewContent = [
          h('p', { class: 'admin-import-success', text: 'Ready to import ' + result.added + ' new product' + (result.added === 1 ? '' : 's') + ' and update ' + result.updated + ' existing product' + (result.updated === 1 ? '' : 's') + '.' }),
          h('div', { class: 'admin-import-preview-wrap' }, h('table', { class: 'admin-table admin-import-preview' },
            h('thead', {}, h('tr', {}, ['Action', 'ID', 'Product', 'Price'].map((label) => h('th', { text: label })))),
            h('tbody', {}, result.products.slice(0, 12).map((product) => h('tr', {},
              h('td', { text: product.action === 'add' ? 'Add' : 'Update' }),
              h('td', { text: product.id }),
              h('td', { text: product.name }),
              h('td', { text: money(product.price) }))))))
        ];
        if (result.products.length > 12) {
          previewContent.push(h('p', { class: 'small muted', text: 'Showing 12 of ' + result.products.length + ' products.' }));
        }
        feedback.replaceChildren(...previewContent);
        importButton.disabled = false;
      } catch (error) {
        if (error.rows) showErrors(error.rows);
        else feedback.replaceChildren(h('p', { class: 'admin-import-error-count', text: error.message }));
      } finally {
        previewButton.disabled = false;
        previewButton.textContent = 'Validate and preview';
      }
    });

    importButton.addEventListener('click', async () => {
      if (!payload) return;
      importButton.disabled = true;
      importButton.textContent = 'Importing…';
      previewButton.disabled = true;
      try {
        const result = await request('/api/admin/products/import', payload);
        const importedById = new Map(result.products.map((product) => [product.id, product]));
        const additions = result.products.filter((product) => !state.products.some((current) => current.id === product.id));
        state.products = [...additions, ...state.products.map((product) => importedById.get(product.id) || product)];
        state.products.forEach((product) => {
          state.knownProductIds.add(product.id);
          state.knownProductNames.set(product.id, product.name);
          state.knownInventorySignals.set(product.id, inventorySignal(product));
        });
        saveNotificationSnapshot();
        const importMessage = [
          result.added + ' added',
          result.updated + ' updated'
        ].join(', ');
        addActivityNotification(
          'product-import:' + Date.now(),
          'Product batch uploaded',
          importMessage + ' successfully.',
          'products'
        );
        closeModal();
        renderShell();
        toast('Imported ' + result.added + ' new product' + (result.added === 1 ? '' : 's') + ' and updated ' + result.updated + '.');
      } catch (error) {
        if (error.rows) showErrors(error.rows);
        else feedback.replaceChildren(h('p', { class: 'admin-import-error-count', text: error.message }));
        importButton.disabled = false;
        importButton.textContent = 'Import products';
        previewButton.disabled = false;
      }
    });

    modalRoot.replaceChildren(h('div', { class: 'admin-modal-backdrop', onclick: (event) => { if (event.target === event.currentTarget) closeModal(); } },
      h('section', { class: 'admin-modal admin-import-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'batchImportTitle' },
        h('div', { class: 'admin-modal-head' }, h('div', {},
          h('h2', { id: 'batchImportTitle', text: 'Batch upload products' }),
          h('p', { text: 'Upload an .xlsx or .csv file. Products are validated together before anything is saved.' })),
        h('button', { class: 'admin-icon-btn', type: 'button', 'aria-label': 'Close dialog', onclick: closeModal }, icon('close', 16))),
        h('div', { class: 'admin-import-guidance' },
          h('strong', { text: 'Required columns: name, category, price.' }),
          h('p', { text: 'Use category names or IDs from your store. A supplied ID updates a match or becomes the new product ID; blank IDs are generated. Use qty for the optional stock quantity; stock is accepted as an older-file alias. Blank optional cells preserve existing values. Separate sizes and colors with commas. Add a direct, publicly accessible HTTPS image URL from any image host, or add an image later by editing the product.' })),
        h('div', { class: 'field admin-import-file-field' }, h('label', { for: 'productImportFile', text: 'Excel or CSV file · maximum 5 MB · 500 products' }),
          Object.assign(selectedFile, { id: 'productImportFile' })),
        feedback,
        h('div', { class: 'admin-modal-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal, text: 'Cancel' }),
          previewButton,
          importButton))));
    selectedFile.focus();
  }

  function closeModal() {
    modalRoot.replaceChildren();
  }

  async function signOut() {
    try {
      await request('/api/admin/logout', {});
      showLogin('You have signed out.');
    } catch (error) {
      toast('Sign-out could not be confirmed: ' + error.message, true);
    }
  }

  async function restoreSession() {
    try {
      const session = await request('/api/admin/session');
      if (!session.authenticated) {
        showLogin();
        return;
      }
      state.email = session.email;
      state.soundEnabled = loadSoundPreference(session.email);
      await loadData();
      startMonitoring();
      renderShell();
    } catch (error) {
      showLogin('Your dashboard session could not be verified. Please sign in again.');
    }
  }

  root.addEventListener('click', (event) => {
    const nav = event.target.closest('.admin-nav');
    if (nav && nav.closest('#adminSidebar')) {
      const sidebar = $('#adminSidebar');
      if (sidebar) sidebar.classList.remove('open');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollForChanges();
  });
  document.addEventListener('pointerdown', activateDashboardAudio, true);
  document.addEventListener('keydown', activateDashboardAudio, true);
  window.addEventListener('focus', () => pollForChanges());
  window.addEventListener('storage', (event) => {
    if (event.key !== notificationStorageKey()) return;
    state.notifications = readNotifications();
    syncSidebarIndicators();
    const wrapper = $('.admin-notifications');
    if (wrapper) {
      if (state.notificationOpen) renderNotificationPanel(wrapper);
      else syncNotificationButton(wrapper);
    }
  });

  restoreSession();
  if (location.pathname === '/dashboard' || location.pathname === '/dashboard/') {
    // Keep the clean /dashboard URL while serving the same noindex admin shell.
    document.title = "Dashboard · Le-Gacy's Importation";
  }
})();
