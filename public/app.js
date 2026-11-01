(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Small helpers. All dynamic text goes through textContent / text nodes,
     never innerHTML, so product names or customer input cannot inject markup.
  ------------------------------------------------------------------ */
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r = document) => r.querySelector(s);

  const ICONS = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    truck: '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5L15.5 10"/>',
    copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    chat: '<path d="M4 20l1.3-4.2A8 8 0 1 1 8.4 18.8z"/><path d="M9 9.5c.5 2.5 2.5 4.5 5 5l1.2-1.2-2-1-.8.8c-.9-.4-1.6-1.1-2-2l.8-.8-1-2z"/>',
    instagram: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="12" cy="12" r="3.6"/><circle cx="16.8" cy="7.2" r=".6"/>',
    tiktok: '<path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 4c.4 2.3 1.9 3.8 4.2 4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    kitchen: '<path d="M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M9 3v6"/><path d="M17 3c-2 1.5-2.5 4-2.5 7h2.5v11"/>',
    gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l-1 5 4 11 4-11-1-5"/>',
    bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
    sport: '<path d="M6 8v8M3.5 10v4M18 8v8M20.5 10v4M6 12h12"/>',
    shirt: '<path d="M8 3l-5 3 2 4 2-1v11h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0z"/>'
  };

  function icon(name, size = 18) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ''; // static, trusted strings only
    return svg;
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const money = (n) => 'GH₵ ' + Number(n).toLocaleString('en-GH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  let carouselTimer = null;
  let orderRefreshTimer = null;
  let trackedOrderSnapshot = '';
  let orderRefreshRunning = false;

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let res;
    try { res = await fetch(path, opts); } catch { throw Object.assign(new Error('You appear to be offline. Check your connection and try again.'), { status: 0 }); }
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong. Please try again.'), { status: res.status, fields: data && data.fields });
    return data;
  }

  function getVisitorId() {
    const key = 'lg_visitor_id';
    const format = (bytes) => {
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
    try {
      const existing = localStorage.getItem(key);
      if (existing && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existing)) return existing;
    } catch { /* Continue with a temporary visitor ID when storage is unavailable. */ }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const id = format(bytes);
    try { localStorage.setItem(key, id); } catch { /* The visitor count still works for this page session. */ }
    return id;
  }

  function recordStorePageView() {
    let visitorId;
    try { visitorId = getVisitorId(); }
    catch (error) {
      console.warn('Store visit could not be recorded:', error.message);
      return;
    }
    fetch('/api/store/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId }),
      keepalive: true
    }).then((response) => {
      if (!response.ok) console.warn('Store visit was not recorded (HTTP ' + response.status + ').');
    }).catch((error) => console.warn('Store visit could not be recorded:', error.message));
  }

  /* ------------------------------------------------------------------
     State
  ------------------------------------------------------------------ */
  const state = { catalog: null, cart: [], session: null };

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem('lg_cart') || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter((i) => i && typeof i.id === 'string'
        && (i.size == null || typeof i.size === 'string')
        && (i.color == null || typeof i.color === 'string')
        && Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 20).slice(0, 30);
    } catch { return []; }
  }
  function saveCart() {
    try { localStorage.setItem('lg_cart', JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
    updateCartUI();
  }
  function getSession() {
    try { const s = JSON.parse(sessionStorage.getItem('lg_session') || 'null'); return s && s.ref && s.phone ? s : null; } catch { return null; }
  }
  function setSession(s) { try { sessionStorage.setItem('lg_session', JSON.stringify(s)); } catch { /* ignore */ } state.session = s; }

  const product = (id) => state.catalog.products.find((p) => p.id === id);
  const category = (id) => state.catalog.categories.find((c) => c.id === id);
  const isPreorder = (p) => !p.inStock && p.preOrder === true;
  const canPurchase = (p) => p && (p.inStock || p.preOrder === true);
  function cartLines() {
    return state.cart.map((i) => ({ p: product(i.id), qty: i.qty, size: i.size, color: i.color })).filter((l) =>
      canPurchase(l.p) && (l.p.sizes && l.p.sizes.length
        ? l.p.sizes.includes(l.size)
        : !l.size) && (l.p.colors && l.p.colors.length
        ? l.p.colors.includes(l.color)
        : !l.color));
  }
  const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);
  const cartTotal = () => cartLines().reduce((n, l) => n + Math.round(l.p.price * 100) * l.qty, 0) / 100;

  function addToCart(id, qty = 1, size = '', color = '') {
    const p = product(id);
    if (!canPurchase(p)
      || (p.sizes && p.sizes.length && !p.sizes.includes(size))
      || (p.colors && p.colors.length && !p.colors.includes(color))) return;
    const line = state.cart.find((i) => i.id === id && (i.size || '') === size && (i.color || '') === color);
    if (line) line.qty = Math.min(20, line.qty + qty);
    else state.cart.push(Object.assign({ id, qty: Math.min(20, qty) }, size ? { size } : {}, color ? { color } : {}));
    saveCart();
    bump();
  }
  function setQty(id, size, color, qty) {
    const line = state.cart.find((i) => i.id === id && (i.size || '') === size && (i.color || '') === color);
    if (!line) return;
    if (qty < 1) state.cart = state.cart.filter((i) =>
      !(i.id === id && (i.size || '') === size && (i.color || '') === color));
    else line.qty = Math.min(20, qty);
    saveCart();
  }

  const waLink = (text) => 'https://wa.me/' + state.catalog.store.whatsapp + '?text=' + encodeURIComponent(text);

  /* ------------------------------------------------------------------
     Shared UI pieces
  ------------------------------------------------------------------ */
  function toast(msg) {
    const box = $('#toasts');
    const t = h('div', { class: 'toast', text: msg });
    box.append(t);
    setTimeout(() => t.remove(), 2400);
  }

  function bump() {
    for (const id of ['cartCount', 'tabCount']) {
      const b = $('#' + id);
      b.classList.remove('bump');
      void b.offsetWidth;
      b.classList.add('bump');
    }
  }

  function media(p, cls = '') {
    const idx = state.catalog.products.indexOf(p);
    const wrap = h('div', { class: ('media t' + (idx % 4) + ' ' + cls).trim() });
    if (p.image && (/^\/(?:uploads|images)\//.test(p.image) || /^https:\/\//i.test(p.image))) {
      wrap.append(h('img', { src: p.image, alt: p.name, loading: 'lazy', width: 400, height: 400 }));
    } else {
      const c = category(p.category);
      const ph = h('span', { class: 'ph' }, icon(c ? c.icon : 'bag', 44));
      wrap.append(ph);
    }
    return wrap;
  }

  function productCard(p, i = 0) {
    const c = category(p.category);
    const preorder = isPreorder(p);
    const hasVariants = (p.sizes && p.sizes.length > 0) || (p.colors && p.colors.length > 0);
    const addBtn = h('button', { class: 'add', type: 'button', 'aria-label': (hasVariants ? 'Choose options for ' : preorder ? 'Pre-order ' : 'Add ') + p.name, disabled: !canPurchase(p),
      onclick: (e) => {
        if (hasVariants) {
          go('/product/' + encodeURIComponent(p.id));
          return;
        }
        addToCart(p.id);
        const b = e.currentTarget;
        b.classList.remove('done'); void b.offsetWidth; b.classList.add('done');
        toast('Added to cart');
      } }, icon('plus', 18));
    return h('article', { class: 'card' },
      h('a', { href: '#/product/' + encodeURIComponent(p.id), 'aria-label': p.name, tabindex: '-1' },
        media(p), preorder && h('span', { class: 'tag tag-preorder', text: 'Pre-order' }), p.inStock && h('span', { class: 'tag tag-available', text: 'Available' }), !p.inStock && !preorder && h('span', { class: 'tag', text: 'Sold out' })),
      h('div', { class: 'card-body' },
        h('span', { class: 'card-cat', text: c ? c.name : '' }),
        h('a', { class: 'card-name', href: '#/product/' + encodeURIComponent(p.id), text: p.name }),
        h('div', { class: 'card-row' }, h('span', { class: 'price', text: money(p.price) }), addBtn)));
  }

  function searchForm(value = '') {
    const input = h('input', { class: 'input', type: 'search', name: 'q', placeholder: 'Search by name, category, or detail', 'aria-label': 'Search by name, category, or detail', value, maxlength: '60', autocomplete: 'off' });
    const clear = h('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear search', hidden: !value, onclick: () => {
      input.value = '';
      form.requestSubmit();
      input.focus();
    } }, icon('x', 15));
    const form = h('form', { class: 'search', role: 'search', onsubmit: (e) => {
      e.preventDefault();
      const q = input.value.trim().slice(0, 60);
      go('/shop' + (q ? '?q=' + encodeURIComponent(q) : ''));
    } }, icon('search', 16), input, clear);
    input.addEventListener('input', () => { clear.hidden = input.value.length === 0; });
    return form;
  }

  function summary(lines, total, extra) {
    return h('div', { class: 'panel sticky' },
      h('h2', { text: 'Order summary' }),
      lines.map((l) => h('div', { class: 'mini' },
        h('span', { text: l.qty + ' × ' + l.name + (l.size ? ' · Size ' + l.size : '') + (l.color ? ' · ' + l.color : '') }), h('span', { text: money(l.price * l.qty) }))),
      h('div', { class: 'total' }, h('span', { text: 'Items total' }), h('span', { text: money(total) })),
      h('p', { class: 'small muted', style: null, text: 'Delivery fee depends on your location and is confirmed with you on WhatsApp.' }),
      extra);
  }

  function field(name, label, opts = {}) {
    const id = 'f-' + name;
    const control = opts.textarea
      ? h('textarea', { class: 'textarea', id, name, maxlength: opts.max || 200, autocomplete: opts.auto || 'off', placeholder: opts.placeholder || '' })
      : h('input', { class: 'input', id, name, type: opts.type || 'text', maxlength: opts.max || 80, autocomplete: opts.auto || 'off', inputmode: opts.inputmode, placeholder: opts.placeholder || '', required: opts.required });
    if (opts.value) control.value = opts.value;
    const err = h('p', { class: 'err', id: id + '-err', 'aria-live': 'polite' });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, opts.hint && h('span', { class: 'hint', text: opts.hint }), err);
  }
  function showFieldErrors(form, fields) {
    form.querySelectorAll('.field').forEach((f) => f.classList.remove('has-error'));
    form.querySelectorAll('.err').forEach((e) => { e.textContent = ''; });
    for (const [k, msg] of Object.entries(fields || {})) {
      const err = form.querySelector('#f-' + k + '-err');
      const input = form.querySelector('#f-' + k);
      if (err) err.textContent = msg;
      if (input) { input.parentElement.classList.add('has-error'); input.setAttribute('aria-invalid', 'true'); }
    }
    const first = form.querySelector('.has-error input, .has-error textarea');
    if (first) first.focus();
  }

  const PHONE_RE = /^(0\d{9}|\+?233\d{9})$/;
  const cleanPhone = (v) => String(v).replace(/[\s\-().]/g, '');

  /* ------------------------------------------------------------------
     Views
  ------------------------------------------------------------------ */
  function viewHome() {
    const { products } = state.catalog;
    const featured = [
      { category: 'phone-accessories', title: 'Everyday tech', caption: 'Useful upgrades for life on the go.', image: 'https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?auto=format&fit=crop&w=1200&q=80', alt: 'Smartphone and accessories arranged on a desk' },
      { category: 'kitchen-home', title: 'A better kitchen', caption: 'Clever finds for cooking and keeping tidy.', image: 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=1200&q=80', alt: 'Bright, modern kitchen' },
      { category: 'jewelry-watches', title: 'Little details', caption: 'Jewelry and watches to finish your look.', image: 'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=1200&q=80', alt: 'Gold jewelry styled for display' },
      { category: 'mens-shoes', title: 'Step out in style', caption: 'Find the right pair for every occasion.', image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1200&q=80', alt: 'Bright red sneaker' },
      { category: 'womens-wear', title: 'Style your way', caption: 'Fresh wardrobe picks for every day.', image: 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1200&q=80', alt: 'Fashion model wearing a contemporary outfit' }
    ];
    const showcaseTrack = h('div', { class: 'showcase-track', tabindex: '0', 'aria-label': 'Swipe or use the controls to browse collections' },
      featured.map((item, i) => h('a', {
        class: 'showcase-slide',
        href: '#/shop?cat=' + encodeURIComponent(item.category),
        role: 'group',
        'aria-roledescription': 'slide',
        'aria-label': (i + 1) + ' of ' + featured.length + ': ' + item.title
      },
      h('img', { src: item.image, alt: item.alt, loading: i === 0 ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }),
      h('span', { class: 'showcase-copy' },
        h('span', { class: 'showcase-eyebrow', text: 'Le-Gacy’s collection' }),
        h('span', { class: 'showcase-title', text: item.title }),
        h('span', { class: 'showcase-caption', text: item.caption }),
        h('span', { class: 'showcase-link' }, 'Explore collection ', icon('chevron', 16))))));
    const dots = featured.map((item, i) => h('button', {
      class: 'showcase-dot',
      type: 'button',
      'aria-label': 'Show ' + item.title,
      'aria-pressed': i === 0 ? 'true' : 'false',
      onclick: () => goToSlide(i)
    }));
    function goToSlide(index) {
      const current = (index + featured.length) % featured.length;
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      showcaseTrack.scrollTo({ left: current * showcaseTrack.clientWidth, behavior });
    }
    let scrollFrame = 0;
    showcaseTrack.addEventListener('scroll', () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        const active = Math.min(featured.length - 1, Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth));
        dots.forEach((dot, i) => dot.setAttribute('aria-pressed', i === active ? 'true' : 'false'));
        scrollFrame = 0;
      });
    }, { passive: true });
    showcaseTrack.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); goToSlide(Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth) + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); goToSlide(Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth) - 1); }
    });
    const showcase = h('section', { class: 'showcase rise', role: 'region', 'aria-roledescription': 'carousel', 'aria-label': 'Shop our collections' },
      showcaseTrack,
      h('button', { class: 'showcase-arrow showcase-prev', type: 'button', 'aria-label': 'Previous collection', onclick: () => goToSlide(Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth) - 1) }, icon('chevron', 20)),
      h('button', { class: 'showcase-arrow showcase-next', type: 'button', 'aria-label': 'Next collection', onclick: () => goToSlide(Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth) + 1) }, icon('chevron', 20)),
      h('div', { class: 'showcase-dots', 'aria-label': 'Choose a collection' }, dots));
    showcase.style.setProperty('--i', 2);
    let carouselFocused = false;
    showcase.addEventListener('mouseenter', () => { showcase.dataset.hovered = 'true'; });
    showcase.addEventListener('mouseleave', () => { delete showcase.dataset.hovered; });
    showcase.addEventListener('focusin', () => { carouselFocused = true; });
    showcase.addEventListener('focusout', (event) => {
      if (!showcase.contains(event.relatedTarget)) carouselFocused = false;
    });
    carouselTimer = window.setInterval(() => {
      if (document.hidden || showcase.dataset.hovered === 'true' || carouselFocused) return;
      goToSlide(Math.round(showcaseTrack.scrollLeft / showcaseTrack.clientWidth) + 1);
    }, 20000);

    const hero = h('section', { class: 'wrap hero' },
      h('div', { class: 'hero-copy' },
        h('h1', { class: 'rise', text: 'Imported finds for home, style and everyday.' }),
        h('p', { class: 'lead rise', style: null, text: 'Browse and order online, then pay securely by card or Mobile Money with Paystack.' }),
        searchForm(),
        h('ul', { class: 'assure' },
          h('li', {}, icon('lock', 15), 'Secure Paystack payments'),
          h('li', {}, icon('chat', 15), 'Confirmed on WhatsApp'),
          h('li', {}, icon('truck', 15), 'Track your order'))),
      showcase);
    for (const el of hero.querySelectorAll('.hero-copy .rise')) el.style.setProperty('--i', 0);

    const categoryImages = {
      'phone-accessories': 'https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?auto=format&fit=crop&w=900&q=80',
      'kitchen-home': 'https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=900&q=80',
      'jewelry-watches': 'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=80',
      'mens-shoes': 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=80',
      'womens-shoes': 'https://images.unsplash.com/photo-1543163521-1bf539c55dd2?auto=format&fit=crop&w=900&q=80',
      'shoes-bags': 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=80',
      'home-textile': 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=900&q=80',
      'mens-sports': 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=900&q=80',
      'mens-wear': 'https://images.unsplash.com/photo-1516826957135-700dedea698c?auto=format&fit=crop&w=900&q=80',
      'womens-wear': 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=80'
    };
    const categorySection = h('section', { class: 'wrap section category-section' },
      h('div', { class: 'section-head' },
        h('div', {}, h('h2', { text: 'Shop by category' }), h('p', { class: 'muted small', text: 'Explore the collections and find something you love.' }))),
      h('div', { class: 'category-grid' }, state.catalog.categories.map((item) =>
        h('a', { class: 'category-tile', href: '#/shop?cat=' + encodeURIComponent(item.id), 'aria-label': 'Shop ' + item.name },
          h('img', { src: categoryImages[item.id] || '', alt: item.name, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }),
          h('span', { class: 'category-tile-copy' }, h('span', { class: 'category-tile-name', text: item.name }), h('span', { class: 'category-tile-link' }, 'Explore ', icon('chevron', 15)))))));

    const latest = h('section', { class: 'wrap section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'Popular right now' }), h('a', { class: 'link', href: '#/shop', text: 'See all products' })),
      h('div', { class: 'grid' }, products.slice(0, 8).map((p, i) => productCard(p, i))));

    const preorderProducts = products.filter(isPreorder);
    const preorder = preorderProducts.length
      ? h('section', { class: 'wrap section' },
        h('div', { class: 'section-head' },
          h('h2', { text: 'Pre-order imports' }),
          h('a', { class: 'link', href: '#/shop?availability=preorder', text: 'See all pre-orders' })),
        h('p', { class: 'muted small', text: 'Imported upon request. Expected arrival is 40–60 days; prices exclude shipping.' }),
        h('div', { class: 'grid' }, preorderProducts.map((p, i) => productCard(p, i))))
      : null;

    const how = h('section', { class: 'wrap section' },
      h('div', { class: 'section-head' }, h('h2', { text: 'How ordering works' })),
      h('ol', { class: 'steps' },
        h('li', {}, h('h3', { text: 'Pick what you like' }), h('p', { text: 'Add items to your cart and enter your delivery details.' })),
        h('li', {}, h('h3', { text: 'Pay securely' }), h('p', { text: 'Pay by card or Mobile Money in the Paystack checkout popup.' })),
        h('li', {}, h('h3', { text: 'We confirm and deliver' }), h('p', { text: 'Your payment is verified automatically, then we arrange delivery.' }))));
    const faqItems = [
      ['How do I place an order?', 'Browse the store, choose any available size or color, and add products to your cart. Enter your contact and delivery details at checkout, then follow the payment instructions.'],
      ['How can I pay?', 'Pay securely by card or Mobile Money through the Paystack checkout. Your payment is verified before your order is updated. Never share your card PIN or Mobile Money PIN.'],
      ['How much is delivery, and when will it arrive?', 'Delivery fees and estimated delivery dates depend on your location. After you order, we’ll contact you on WhatsApp to confirm the delivery method, fee, and timing.'],
      ['How long do pre-orders take?', 'Pre-order items are expected to arrive in about 40–60 days. Prices exclude shipping; we’ll confirm delivery arrangements with you on WhatsApp.'],
      ['How do I track my order?', 'Open Track order and enter your order number and the phone number you used when ordering. We’ll also contact you on WhatsApp about delivery arrangements.'],
      ['What if my item is damaged, incorrect, or missing?', 'Contact us on WhatsApp with your order number and a short description of the issue. Photos can help us review your request. We’ll confirm the available next steps with you.'],
      ['Can I cancel an order or request a refund?', 'Contact us as soon as possible. We’ll check the order’s status and review your request. Refund eligibility, method, and timing are confirmed individually; refunds are not automatic.'],
      ['How do I ask about a product?', 'Message us on WhatsApp with the product name and any questions about its options or availability.']
    ];
    const faq = h('section', { class: 'wrap section faq-section', 'aria-labelledby': 'faq-title' },
      h('div', { class: 'faq-heading' },
        h('span', { class: 'faq-eyebrow', text: 'Need a hand?' }),
        h('h2', { id: 'faq-title', text: 'Frequently asked questions' }),
        h('p', { class: 'muted', text: 'Quick answers to help you shop with confidence.' })),
      h('div', { class: 'faq-list' }, faqItems.map(([question, answer], i) =>
        h('details', { class: 'faq-item' },
          h('summary', {}, h('span', { class: 'faq-number', text: String(i + 1).padStart(2, '0') }), h('span', { class: 'faq-question', text: question })),
          h('p', { class: 'faq-answer', text: answer })))),
      h('p', { class: 'faq-contact' }, 'Still have a question? ',
        h('a', { class: 'link', href: waLink('Hello, I have a question about your store.'), target: '_blank', rel: 'noopener noreferrer', text: 'Chat with us on WhatsApp' })));
    return [hero, categorySection, latest, preorder, how, faq].filter(Boolean);
  }

  function viewShop(params) {
    const { categories, products } = state.catalog;
    const cat = params.get('cat') || '';
    const q = (params.get('q') || '').trim().slice(0, 60);
    const availability = ['available', 'preorder'].includes(params.get('availability')) ? params.get('availability') : 'all';
    const sort = ['low', 'high'].includes(params.get('sort')) ? params.get('sort') : 'new';

    const queryTerms = normalizeSearchText(q).split(' ').filter(Boolean);
    const filteredProducts = products.filter((p) =>
      (!cat || p.category === cat) &&
      (availability === 'available' ? p.inStock : availability === 'preorder' ? isPreorder(p) : true));
    let list = filteredProducts;
    if (queryTerms.length) {
      const matches = filteredProducts.map((p) => {
        const text = productSearchText(p);
        const matchedTerms = queryTerms.filter((term) => searchTermMatches(text, term)).length;
        return { product: p, matchedTerms };
      });
      const exactMatches = matches.filter((match) => match.matchedTerms === queryTerms.length);
      if (exactMatches.length) {
        list = exactMatches.map((match) => match.product);
      } else {
        const bestMatchCount = Math.max(0, ...matches.map((match) => match.matchedTerms));
        list = matches.filter((match) => match.matchedTerms === bestMatchCount && bestMatchCount > 0)
          .map((match) => match.product);
      }
    }
    if (sort === 'low') list = list.slice().sort((a, b) => a.price - b.price);
    if (sort === 'high') list = list.slice().sort((a, b) => b.price - a.price);

    const build = (over) => {
      const n = new URLSearchParams();
      const next = Object.assign({ cat, q, sort, availability }, over);
      if (next.cat) n.set('cat', next.cat);
      if (next.q) n.set('q', next.q);
      if (next.sort && next.sort !== 'new') n.set('sort', next.sort);
      if (next.availability && next.availability !== 'all') n.set('availability', next.availability);
      const s = n.toString();
      return '/shop' + (s ? '?' + s : '');
    };

    const search = searchForm(q);
    search.onsubmit = (e) => { e.preventDefault(); go(build({ q: search.querySelector('input').value.trim().slice(0, 60) })); };
    const select = h('select', { class: 'select', 'aria-label': 'Sort products', onchange: (e) => go(build({ sort: e.target.value })) },
      h('option', { value: 'new', text: 'Featured' }), h('option', { value: 'low', text: 'Price: low to high' }), h('option', { value: 'high', text: 'Price: high to low' }));
    select.value = sort;

    const chips = h('nav', { class: 'browse-filters', 'aria-label': 'Browse categories' },
      h('div', { class: 'chips' },
        h('a', { class: 'chip', href: '#' + build({ cat: '' }), 'aria-current': String(!cat), text: 'All' }),
        categories.map((c) => h('a', { class: 'chip', href: '#' + build({ cat: c.id }), 'aria-current': String(cat === c.id), text: c.name }))),
      h('div', { class: 'availability-filters', role: 'group', 'aria-label': 'Filter by availability' },
        [['all', 'All'], ['available', 'Available Now'], ['preorder', 'Pre-order']].map(([value, label]) =>
          h('a', { class: 'chip', href: '#' + build({ availability: value }), 'aria-current': String(availability === value), text: label }))));

    const current = category(cat);
    return h('div', { class: 'wrap' },
      h('div', { class: 'shop-head' }, h('h1', { text: current ? current.name : q ? 'Results for “' + q + '”' : 'All products' }),
        h('p', { class: 'muted small', text: list.length + (list.length === 1 ? ' item' : ' items') })),
      h('div', { class: 'toolbar' }, search, select),
      chips,
      list.length && (cat || q || availability !== 'all' || sort !== 'new')
        ? h('div', { class: 'filter-reset-row' }, h('a', { class: 'link', href: '#/shop', text: 'Clear search and filters' }))
        : null,
      list.length
        ? h('div', { class: 'grid' }, list.map((p, i) => productCard(p, i)))
        : h('div', { class: 'empty' }, h('h2', { text: availability === 'preorder' && !queryTerms.length ? 'No pre-order items listed yet' : 'No products found' }), h('p', { text: queryTerms.length || cat || availability !== 'all' ? 'Try another search or clear your filters to see more products.' : 'Products will appear here when available.' }),
          h('a', { class: 'btn', href: '#/shop', text: 'Clear search and filters' })));
  }

  function normalizeSearchText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function searchTermMatches(text, term) {
    if (text.includes(term)) return true;
    if (term.length > 4 && term.endsWith('ies') && text.includes(term.slice(0, -3) + 'y')) return true;
    return term.length > 4 && term.endsWith('s') && !term.endsWith('ss') && text.includes(term.slice(0, -1));
  }

  function productSearchText(product) {
    const productCategory = category(product.category);
    return normalizeSearchText([
      product.id,
      product.name,
      product.description,
      product.category,
      productCategory ? productCategory.name : '',
      ...(Array.isArray(product.sizes) ? product.sizes : []),
      ...(Array.isArray(product.colors) ? product.colors : [])
    ].join(' '));
  }

  function viewProduct(id) {
    const p = product(id);
    if (!p) return viewNotFound();
    const c = category(p.category);
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const colors = Array.isArray(p.colors) ? p.colors : [];
    let selectedSize = '';
    let selectedColor = '';
    let qty = 1;
    const out = h('output', { text: '1', 'aria-live': 'polite' });
    const dec = h('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => { qty = Math.max(1, qty - 1); out.textContent = qty; } }, icon('minus', 16));
    const inc = h('button', { type: 'button', 'aria-label': 'Increase quantity', onclick: () => { qty = Math.min(20, qty + 1); out.textContent = qty; } }, icon('plus', 16));
    const sizeSelect = sizes.length
      ? h('select', { class: 'select size-select', id: 'product-size', 'aria-label': 'Select a size', required: true },
        h('option', { value: '', text: 'Please select a size' }),
        sizes.map((size) => h('option', { value: size, text: 'Size ' + size + ' — ' + money(p.price) })))
      : null;
    const colorSelect = colors.length
      ? h('select', { class: 'select size-select', id: 'product-color', 'aria-label': 'Select a color', required: true },
        h('option', { value: '', text: 'Please select a color' }),
        colors.map((color) => h('option', { value: color, text: color })))
      : null;
    const variantsSelected = () => (!sizeSelect || selectedSize) && (!colorSelect || selectedColor);
    const addButton = h('button', { class: 'btn', type: 'button', disabled: !variantsSelected(), onclick: () => {
      addToCart(p.id, qty, selectedSize, selectedColor);
      toast(isPreorder(p) ? 'Pre-order added to cart' : 'Added to cart');
    } }, isPreorder(p) ? 'Pre-order' : 'Add to cart');
    const buyButton = h('button', { class: 'btn btn-ghost', type: 'button', disabled: !variantsSelected(), onclick: () => {
      addToCart(p.id, qty, selectedSize, selectedColor);
      go('/checkout');
    } }, isPreorder(p) ? 'Pre-order now' : 'Buy now');
    const updateVariantButtons = () => {
      addButton.disabled = !variantsSelected();
      buyButton.disabled = !variantsSelected();
    };
    if (sizeSelect) sizeSelect.addEventListener('change', () => { selectedSize = sizeSelect.value; updateVariantButtons(); });
    if (colorSelect) colorSelect.addEventListener('change', () => { selectedColor = colorSelect.value; updateVariantButtons(); });
    const related = state.catalog.products.filter((r) => r.category === p.category && r.id !== p.id).slice(0, 4);
    return h('div', { class: 'wrap' },
      h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
        h('a', { href: '#/shop', text: 'Shop' }), icon('chevron', 12),
        c && h('a', { href: '#/shop?cat=' + encodeURIComponent(c.id), text: c.name })),
      h('section', { class: 'pdp' },
        media(p),
        h('div', {},
          h('h1', { text: p.name }),
          h('span', { class: 'price', text: money(p.price) }),
          h('p', { class: 'desc', text: p.description }),
          canPurchase(p)
            ? h('div', { class: 'buy-row' },
              sizeSelect && h('div', { class: 'size-field' },
                h('label', { for: 'product-size', text: 'Size' }),
                sizeSelect),
              colorSelect && h('div', { class: 'size-field' },
                h('label', { for: 'product-color', text: 'Color' }),
                colorSelect),
              h('div', { class: 'qty' }, dec, out, inc),
              addButton,
              buyButton)
            : h('p', { class: 'alert alert-warn', text: 'This item is sold out right now. Message us on WhatsApp to ask when it returns.' }),
          isPreorder(p) && h('p', { class: 'alert alert-info preorder-note', text: 'Pre-order Import\nExpected Arrival: 40-60 days\nNote: Price excludes shipping cost.' }),
          h('ul', { class: 'facts' },
            h('li', {}, icon('lock', 16), 'Pay securely with Paystack at checkout'),
            h('li', {}, icon('chat', 16), h('a', { class: 'link', href: waLink('Hi, I have a question about: ' + p.name), target: '_blank', rel: 'noopener noreferrer', text: 'Ask about this item on WhatsApp' }))))),
      related.length > 0 && h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', { text: 'You may also like' })),
        h('div', { class: 'grid' }, related.map((r, i) => productCard(r, i)))));
  }

  function progress(step) {
    const labels = ['Your details', 'Pay', 'Confirmation'];
    return h('ol', { class: 'progress', 'aria-label': 'Checkout progress' }, labels.map((t, i) =>
      h('li', { class: i + 1 < step ? 'done' : i + 1 === step ? 'on' : '', 'aria-current': i + 1 === step ? 'step' : null },
        h('span', { class: 'n' }, i + 1 < step ? icon('check', 12) : String(i + 1)), t)));
  }

  async function beginPaystack(order, phone, publicKey, onClose) {
    if (!window.PaystackPop || typeof window.PaystackPop.setup !== 'function') {
      throw new Error('Paystack checkout could not load. Check your connection and try again.');
    }
    const { reference } = await api('/api/orders/paystack/reference', { ref: order.ref, phone });
    return new Promise((resolve, reject) => {
      let callbackReceived = false;
      async function completePayment(result) {
        try {
          if (!result || result.reference !== reference) throw new Error('Paystack returned an unexpected payment reference.');
          await api('/api/orders/paystack/verify', { ref: order.ref, phone, reference: result.reference });
          go('/order/' + encodeURIComponent(order.ref));
        } catch (err) {
          toast(err.message);
          go('/pay/' + encodeURIComponent(order.ref));
        }
      }
      const handler = window.PaystackPop.setup({
        key: publicKey,
        email: order.customerEmail,
        amount: Math.round(order.subtotal * 100),
        currency: 'GHS',
        ref: reference,
        metadata: { order_reference: order.ref },
        callback: function (result) {
          callbackReceived = true;
          completePayment(result);
        },
        onClose: function () {
          if (!callbackReceived) onClose();
          resolve();
        }
      });
      try { handler.openIframe(); } catch (err) { reject(err); }
    });
  }

  function viewCheckout() {
    const lines = cartLines();
    if (!lines.length) {
      return h('div', { class: 'wrap page' }, h('div', { class: 'empty' }, h('h2', { text: 'Your cart is empty' }), h('p', { text: 'Add something you like, then come back to check out.' }), h('a', { class: 'btn', href: '#/shop', text: 'Browse products' })));
    }
    const msg = h('div', { role: 'alert' });
    const trap = h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', { for: 'f-website', text: 'Leave this field empty' }), h('input', { id: 'f-website', name: 'website', tabindex: '-1', autocomplete: 'off' }));
    const submit = h('button', { class: 'btn btn-wide', type: 'submit' }, 'Checkout and pay securely');
    const form = h('form', { class: 'form-grid', novalidate: true, autocomplete: 'on' },
      field('name', 'Full name', { auto: 'name', required: true, max: 80 }),
      field('email', 'Email address', { type: 'email', auto: 'email', required: true, max: 120, placeholder: 'you@example.com', hint: 'Paystack uses this to send your payment receipt.' }),
      h('div', { class: 'form-2' },
        field('phone', 'Phone number', { type: 'tel', auto: 'tel', inputmode: 'tel', required: true, max: 16, placeholder: '0244123456', hint: 'We use this to confirm your order and find it later.' }),
        field('town', 'Town or city', { auto: 'address-level2', required: true, max: 60 })),
      field('address', 'Delivery address or landmark', { auto: 'street-address', required: true, max: 160 }),
      field('notes', 'Notes (optional)', { textarea: true, max: 200, placeholder: 'Any other details we should know' }),
      trap, msg, submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = ''; msg.textContent = '';
      const data = Object.fromEntries(new FormData(form).entries());
      const fields = {};
      if (String(data.name).trim().length < 2) fields.name = 'Enter your full name.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email).trim())) fields.email = 'Enter a valid email address for your Paystack receipt.';
      if (!PHONE_RE.test(cleanPhone(data.phone))) fields.phone = 'Enter a valid Ghana phone number, e.g. 0244123456.';
      if (String(data.town).trim().length < 2) fields.town = 'Enter your town or city.';
      if (String(data.address).trim().length < 5) fields.address = 'Enter your delivery address or a nearby landmark.';
      showFieldErrors(form, fields);
      if (Object.keys(fields).length) return;

      submit.disabled = true; submit.textContent = 'Opening secure payment…';
      let order;
      let phone;
      try {
        const config = await api('/api/paystack/config');
        if (!config.enabled) throw new Error('Online payment is not available right now. Please contact us on WhatsApp.');
        ({ order } = await api('/api/orders', {
          name: data.name, email: data.email, phone: data.phone, town: data.town, address: data.address, notes: data.notes, website: data.website,
          items: lines.map((l) => ({ id: l.p.id, qty: l.qty, size: l.size, color: l.color }))
        }));
        phone = cleanPhone(data.phone);
        setSession({ ref: order.ref, phone, email: data.email });
        state.cart = []; saveCart();
        await beginPaystack(order, phone, config.publicKey, () => go('/pay/' + encodeURIComponent(order.ref)));
      } catch (err) {
        if (order) {
          go('/pay/' + encodeURIComponent(order.ref));
          toast(err.message);
          return;
        }
        submit.disabled = false; submit.textContent = 'Place order and continue to payment';
        if (err.fields) showFieldErrors(form, err.fields);
        msg.className = 'alert alert-err'; msg.textContent = err.message;
        if (err.status === 409) { state.cart = state.cart.filter((i) => canPurchase(product(i.id))); saveCart(); }
      }
    });

    return h('div', { class: 'wrap page' },
      h('h1', { text: 'Checkout' }), progress(1),
      h('div', { class: 'cols' },
        h('div', { class: 'panel' }, h('h2', { text: 'Delivery details' }), form),
        summary(lines.map((l) => ({ name: l.p.name, size: l.size, color: l.color, qty: l.qty, price: l.p.price })), cartTotal(),
          h('p', { class: 'small muted' }, icon('shield', 14), ' Prices are checked again on our server when you place the order.'))));
  }

  async function loadOrder(ref) {
    const s = getSession();
    if (!s || s.ref !== ref) return null;
    const { order } = await api('/api/orders/track', { ref: s.ref, phone: s.phone });
    return order;
  }

  function needLookup(ref) {
    return h('div', { class: 'wrap page' }, h('div', { class: 'panel track-box' },
      h('h2', { text: 'Confirm it’s your order' }),
      h('p', { class: 'muted', text: 'For your privacy, enter the phone number you used when ordering to view this order.' }),
      trackForm(ref)));
  }

  function copyBtn(text, label) {
    return h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Copy ' + label, onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Press and hold to copy'); }
    } }, icon('copy', 14), 'Copy');
  }

  async function viewPay(ref) {
    let order;
    try { order = await loadOrder(ref); } catch (err) { return needLookup(ref); }
    if (!order) return needLookup(ref);
    if (order.status !== 'awaiting_payment') { go('/order/' + encodeURIComponent(ref), true); return h('div'); }

    const store = state.catalog.store;
    const paystackMsg = h('div', { role: 'alert' });
    const paystackButton = h('button', { class: 'btn btn-wide', type: 'button', disabled: !order.customerEmail, text: 'Pay securely with Paystack · ' + money(order.subtotal), onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      button.textContent = 'Connecting to Paystack…';
      paystackMsg.className = ''; paystackMsg.textContent = '';
      try {
        const config = await api('/api/paystack/config');
        if (!config.enabled) throw new Error('Online payment is not available right now. Please contact us on WhatsApp.');
        const session = getSession();
        await beginPaystack(order, session.phone, config.publicKey, () => {});
        button.textContent = 'Pay securely with Paystack · ' + money(order.subtotal);
        button.disabled = false;
      } catch (err) {
        button.textContent = 'Pay securely with Paystack · ' + money(order.subtotal);
        button.disabled = false;
        paystackMsg.className = 'alert alert-err'; paystackMsg.textContent = err.message;
      }
    } });
    const msg = h('div', { role: 'alert' });
    const submit = h('button', { class: 'btn btn-wide', type: 'submit' }, 'I have paid, submit details');
    const form = h('form', { class: 'form-grid', novalidate: true },
      field('txnId', 'Transaction ID from your SMS', { max: 24, auto: 'off', required: true, placeholder: 'e.g. 4123456789', hint: 'Letters and numbers only.' }),
      field('payerName', 'Name on the Mobile Money wallet you paid from', { max: 80, auto: 'name', required: true }),
      msg, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = ''; msg.textContent = '';
      const d = Object.fromEntries(new FormData(form).entries());
      const fields = {};
      if (!/^[A-Za-z0-9]{6,24}$/.test(String(d.txnId).trim())) fields.txnId = 'Enter the transaction ID from your Mobile Money SMS (letters and numbers only).';
      if (String(d.payerName).trim().length < 2) fields.payerName = 'Enter the name on the wallet you paid from.';
      showFieldErrors(form, fields);
      if (Object.keys(fields).length) return;
      submit.disabled = true; submit.textContent = 'Submitting…';
      try {
        const s = getSession();
        await api('/api/orders/pay', { ref: s.ref, phone: s.phone, txnId: d.txnId, payerName: d.payerName });
        go('/order/' + encodeURIComponent(ref));
      } catch (err) {
        submit.disabled = false; submit.textContent = 'I have paid, submit details';
        if (err.fields) showFieldErrors(form, err.fields);
        msg.className = 'alert alert-err'; msg.textContent = err.message;
      }
    });

    return h('div', { class: 'wrap page' },
      h('h1', { text: 'Complete your payment' }), progress(2),
      h('div', { class: 'cols' },
        h('div', {},
          h('div', { class: 'panel' },
            h('h2', { text: 'Order ' + order.ref + ' is reserved' }),
            h('p', { class: 'muted small', text: order.customerEmail
              ? 'Pay securely by card or Mobile Money with Paystack. A receipt will be sent to ' + order.customerEmail + '.'
              : 'This older order can still be paid by manual Mobile Money below.' }),
            h('div', { class: 'mt', hidden: !order.customerEmail }, paystackButton),
            paystackMsg,
            order.customerEmail && h('p', { class: 'small muted', text: 'Payment is verified automatically. Do not close this page until Paystack confirms your payment.' }),
          ),
            !order.customerEmail && h('div', {},
              h('hr'),
              h('h2', { text: 'Pay by Mobile Money manually' }),
              h('ol', { class: 'pay-steps' },
                h('li', {}, h('div', {}, h('strong', { text: 'Send this amount' }),
                  h('div', { class: 'copy-box' }, h('strong', { text: money(order.subtotal) }), copyBtn(String(order.subtotal), 'amount')),
                  h('p', { class: 'small muted', text: 'This is the items total. We confirm any delivery fee with you separately on WhatsApp.' }))),
                h('li', {}, h('div', {}, h('strong', { text: 'To this Mobile Money number' }),
                  h('div', { class: 'copy-box' }, h('strong', { text: store.momoNumber }), copyBtn(store.momoNumber, 'number')),
                  h('p', { class: 'small muted', text: 'Use ' + order.ref + ' as the payment reference if your wallet asks for one.' }))),
                h('li', {}, h('div', {}, h('strong', { text: 'Enter the transaction ID below' }),
                  h('p', { class: 'small muted', text: 'You will get it in the SMS from your network after paying.' })))),
              h('div', { class: 'alert alert-warn', text: 'Only pay to ' + store.momoNumber + '. We will never ask you to pay to any other number or share your PIN.' }),
              h('div', { class: 'panel' }, h('h2', { text: 'Payment details' }), form))),
        summary(order.items, order.subtotal,
          h('a', { class: 'link small', target: '_blank', rel: 'noopener noreferrer', href: waLink('Hi, I placed order ' + order.ref + ' and need help with payment.'), text: 'Need help? Chat on WhatsApp' }))));
  }

  const FLOW = [
    ['awaiting_payment', 'Order placed'],
    ['payment_submitted', 'Payment details received'],
    ['confirmed', 'Payment confirmed'],
    ['processing', 'Processing your order'],
    ['dispatched', 'On the way'],
    ['delivered', 'Delivered']
  ];
  const STATUS_TEXT = {
    awaiting_payment: ['Awaiting payment', 'warn'], payment_submitted: ['Checking payment', ''], confirmed: ['Confirmed', 'ok'],
    processing: ['Processing your order', ''], dispatched: ['On the way', 'ok'], delivered: ['Delivered', 'ok'], cancelled: ['Cancelled', 'bad']
  };

  async function viewOrder(ref) {
    let order;
    try { order = await loadOrder(ref); } catch (err) { return needLookup(ref); }
    if (!order) return needLookup(ref);
    trackedOrderSnapshot = order.status + ':' + order.updatedAt;
    const [label, tone] = STATUS_TEXT[order.status] || ['Processing', ''];
    const idx = FLOW.findIndex((f) => f[0] === order.status);
    const paystackPaid = !!(order.payment && order.payment.provider === 'paystack');
    const justPaid = order.status === 'payment_submitted' || paystackPaid;
    const updatedAt = new Date(order.updatedAt || order.createdAt);

    return h('div', { class: 'wrap page' },
      h('h1', { text: justPaid ? 'Thank you, ' + order.customerName.split(' ')[0] : 'Order ' + order.ref }),
      justPaid && progress(3),
      h('div', { class: 'cols' },
        h('div', {},
          justPaid && h('div', { class: 'panel success' },
            h('div', { class: 'check' }, icon('check', 22)),
            h('h2', { text: paystackPaid ? 'Payment confirmed' : 'Payment details received' }),
            h('p', { class: 'muted', text: paystackPaid
              ? 'Your Paystack payment is confirmed. Keep your order number: ' + order.ref + '.'
              : 'We will check your payment and confirm on WhatsApp. Keep your order number: ' + order.ref + '.' }),
            h('div', { class: 'row', style: null }, h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer', href: waLink('Hi, I have paid for order ' + order.ref + '.'), text: 'Tell us on WhatsApp' }))),
          h('div', { class: 'panel' },
            h('h2', {}, 'Status ', h('span', { class: 'status-pill ' + tone, text: label })),
            order.status === 'cancelled'
              ? h('p', { class: 'alert alert-err', text: 'This order was cancelled. Contact us on WhatsApp if you think this is a mistake.' })
              : h('ol', { class: 'timeline', 'aria-label': 'Order delivery progress' }, FLOW.map((f, i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', text: f[1] }))),
            Number.isNaN(updatedAt.getTime()) ? null : h('p', {
              class: 'small muted order-updated',
              text: 'Last updated ' + updatedAt.toLocaleString('en-GH', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '. This tracker refreshes automatically.'
            }),
            order.status === 'awaiting_payment' && h('a', { class: 'btn btn-wide', href: '#/pay/' + encodeURIComponent(order.ref), text: 'Complete payment' }))),
        summary(order.items, order.subtotal)));
  }

  function trackForm(prefillRef = '') {
    const msg = h('div', { role: 'alert' });
    const submit = h('button', { class: 'btn btn-wide', type: 'submit' }, 'Find my order');
    const form = h('form', { class: 'form-grid', novalidate: true },
      field('ref', 'Order number', { max: 20, placeholder: 'LG-1A2B3C4D', value: prefillRef, required: true }),
      field('phone', 'Phone number used when ordering', { type: 'tel', inputmode: 'tel', auto: 'tel', max: 16, required: true }),
      msg, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = ''; msg.textContent = '';
      const d = Object.fromEntries(new FormData(form).entries());
      const fields = {};
      if (!/^LG-[A-Za-z0-9]{6,10}$/.test(String(d.ref).trim())) fields.ref = 'Enter your order number, e.g. LG-1A2B3C4D.';
      if (!PHONE_RE.test(cleanPhone(d.phone))) fields.phone = 'Enter a valid Ghana phone number.';
      showFieldErrors(form, fields);
      if (Object.keys(fields).length) return;
      submit.disabled = true; submit.textContent = 'Looking…';
      try {
        const ref = String(d.ref).trim().toUpperCase();
        await api('/api/orders/track', { ref, phone: d.phone });
        setSession({ ref, phone: cleanPhone(d.phone) });
        go('/order/' + encodeURIComponent(ref));
      } catch (err) {
        submit.disabled = false; submit.textContent = 'Find my order';
        msg.className = 'alert alert-err'; msg.textContent = err.message;
      }
    });
    return form;
  }

  function viewTrack() {
    return h('div', { class: 'wrap page' }, h('h1', { text: 'Track your order' }),
      h('p', { class: 'muted', style: null, text: 'Enter your order number and the phone number you ordered with.' }),
      h('div', { class: 'panel track-box', style: null }, trackForm()));
  }

  function viewPolicy(kind) {
    const shipping = kind === 'shipping';
    const title = shipping ? 'Shipping Policy' : 'Refund Policy';
    const sections = shipping
      ? [
          ['Delivery arrangements', 'We confirm your delivery method, fee and estimated delivery date with you on WhatsApp after you place your order. Delivery fees depend on your location.'],
          ['Keep an eye on your order', 'Use Track order on this website to check your order status. We’ll contact you on WhatsApp to confirm arrangements and let you know if anything changes.'],
          ['Need to update your address?', 'Contact us as soon as possible with your order number. We’ll confirm whether the delivery details can still be changed.']
        ]
      : [
          ['Contact us about an issue', 'If an item is damaged, incorrect or missing, contact us on WhatsApp with your order number and a short description of the issue. Photos can help us review your request.'],
          ['Order cancellations', 'If you need to cancel, contact us as soon as possible. We’ll check whether the order has already been prepared or dispatched and confirm what options are available.'],
          ['Review and resolution', 'We review each request and confirm the available next steps with you before taking action. Refund eligibility, method and timing are confirmed individually; a refund is not automatic.']
        ];
    return h('article', { class: 'wrap policy-page' },
      h('a', { class: 'policy-back', href: '#/', text: '← Back to store' }),
      h('header', { class: 'policy-header' },
        h('span', { class: 'policy-eyebrow', text: "Le-Gacy's Importation" }),
        h('h1', { text: title }),
        h('p', { text: shipping
          ? 'What to expect when we arrange delivery for your order.'
          : 'How to get in touch if something isn’t right with your order.' })),
      h('div', { class: 'policy-sections' }, sections.map(([heading, body], i) =>
        h('section', { class: 'policy-card' },
          h('span', { class: 'policy-step', 'aria-hidden': 'true', text: String(i + 1).padStart(2, '0') }),
          h('div', {}, h('h2', { text: heading }), h('p', { text: body }))))),
      h('aside', { class: 'policy-contact' },
        h('div', {}, h('h2', { text: 'Questions? We’re here to help.' }),
          h('p', { text: 'Message us with your order number and we’ll get back to you.' })),
        h('a', { class: 'btn', href: waLink('Hello, I have a question about my order.'), target: '_blank', rel: 'noopener noreferrer' }, icon('chat', 16), 'Chat on WhatsApp')));
  }

  function viewPaymentInfo() {
    const s = state.catalog.store;
    return h('article', { class: 'wrap policy-page payment-page' },
      h('a', { class: 'policy-back', href: '#/', text: '← Back to store' }),
      h('header', { class: 'policy-header' },
        h('span', { class: 'policy-eyebrow', text: "Le-Gacy's Importation" }),
        h('h1', { text: 'Secure online payments' }),
        h('p', { text: 'Pay for your order safely through Paystack.' })),
      h('section', { class: 'payment-card' },
        h('span', { class: 'payment-label', text: 'Paystack checkout' }),
        h('p', { class: 'payment-number', text: 'Card or Mobile Money' }),
        h('p', { class: 'muted', text: 'Place your order and the secure Paystack checkout popup will open. Your payment is verified automatically; never share your card PIN or Mobile Money PIN.' })),
      h('ol', { class: 'payment-steps' },
        h('li', {}, h('strong', { text: 'Place your order' }), h('span', { text: 'Your order page will show the amount due and your order number.' })),
        h('li', {}, h('strong', { text: 'Complete secure payment' }), h('span', { text: 'Choose a supported card or Mobile Money option in Paystack.' })),
        h('li', {}, h('strong', { text: 'Payment is verified' }), h('span', { text: 'We confirm the exact amount with Paystack before updating your order.' }))),
      h('p', { class: 'payment-reminder', text: 'If Paystack is unavailable, contact us on WhatsApp for assistance with manual Mobile Money payment.' }),
      h('a', { class: 'btn', href: '#/shop', text: 'Continue shopping' }));
  }

  function viewNotFound() {
    return h('div', { class: 'wrap page' }, h('div', { class: 'empty' }, h('h2', { text: 'We couldn’t find that page' }), h('p', { text: 'It may have moved or the product is no longer listed.' }), h('a', { class: 'btn', href: '#/shop', text: 'Back to shop' })));
  }

  /* ------------------------------------------------------------------
     Footer
  ------------------------------------------------------------------ */
  function renderFooter() {
    const s = state.catalog.store;
    const f = $('#footer');
    f.replaceChildren(
      h('div', { class: 'wrap foot' },
        h('section', { class: 'foot-brand', 'aria-label': 'About Le-Gacy’s Importation' },
          h('a', { class: 'brand foot-logo', href: '#/', 'aria-label': "Le-Gacy's Importation, home" },
            h('img', { class: 'brand-logo', src: '/legacys-logo.svg', alt: '' })),
          h('p', { class: 'foot-motto', text: 'Quality imports for your home, style and everyday life.' })),
        h('section', { class: 'foot-contact', 'aria-labelledby': 'footer-contact-title' },
          h('h2', { id: 'footer-contact-title', text: 'We’re here to help' }),
          h('div', { class: 'contact-links' },
            h('a', { class: 'contact-link', href: waLink('Hello, I would like to ask about your products.'), target: '_blank', rel: 'noopener noreferrer' },
              h('span', { class: 'contact-icon' }, icon('chat', 17)), h('span', {}, h('span', { class: 'contact-label', text: 'WhatsApp' }), h('span', { class: 'contact-value', text: s.whatsappDisplay }))),
            h('a', { class: 'contact-link', href: 'https://www.instagram.com/' + encodeURIComponent(s.instagram), target: '_blank', rel: 'noopener noreferrer' },
              h('span', { class: 'contact-icon' }, icon('instagram', 17)), h('span', {}, h('span', { class: 'contact-label', text: 'Instagram' }), h('span', { class: 'contact-value', text: '@' + s.instagram }))),
            h('a', { class: 'contact-link', href: 'https://www.tiktok.com/search?q=' + encodeURIComponent(s.tiktokName), target: '_blank', rel: 'noopener noreferrer' },
              h('span', { class: 'contact-icon' }, icon('tiktok', 17)), h('span', {}, h('span', { class: 'contact-label', text: 'TikTok' }), h('span', { class: 'contact-value', text: s.tiktokName }))),
            h('a', { class: 'contact-link', href: '#/track' },
              h('span', { class: 'contact-icon' }, icon('truck', 17)), h('span', {}, h('span', { class: 'contact-label', text: 'Order support' }), h('span', { class: 'contact-value', text: 'Track your order' })))))),
      h('div', { class: 'legal-wrap' },
        h('div', { class: 'wrap legal' },
          h('span', { class: 'copyright', text: '© ' + new Date().getFullYear() + ' ' + s.name }),
          h('nav', { class: 'legal-links', 'aria-label': 'Payment and store policies' },
            h('a', { href: '#/payment', text: 'Secure payments' }),
            h('a', { href: '#/shipping-policy', text: 'Shipping Policy' }),
            h('a', { href: '#/refund-policy', text: 'Refund Policy' })))));
  }

  /* ------------------------------------------------------------------
     Cart drawer
  ------------------------------------------------------------------ */
  let lastFocus = null;
  function openDrawer() {
    renderDrawer();
    lastFocus = document.activeElement;
    $('#scrim').hidden = false;
    const d = $('#drawer');
    d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
    for (const el of ['.top', '#main', '#footer', '.tabbar']) $(el).setAttribute('inert', '');
    $('#drawerClose').focus();
  }
  function closeDrawer() {
    $('#scrim').hidden = true;
    const d = $('#drawer');
    d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
    for (const el of ['.top', '#main', '#footer', '.tabbar']) $(el).removeAttribute('inert');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  const drawerOpen = () => $('#drawer').classList.contains('open');

  function renderDrawer() {
    const body = $('#drawerBody');
    const foot = $('#drawerFoot');
    const lines = cartLines();
    if (!lines.length) {
      body.replaceChildren(h('div', { class: 'empty', style: null }, h('h2', { text: 'Your cart is empty' }), h('p', { text: 'Items you add will show up here.' }),
        h('a', { class: 'btn', href: '#/shop', onclick: closeDrawer, text: 'Browse products' })));
      foot.replaceChildren();
      return;
    }
    body.replaceChildren(...lines.map(({ p, qty, size, color }) => h('div', { class: 'line' },
      media(p),
      h('div', {},
        h('div', { class: 'line-name', text: p.name + (size ? ' · Size ' + size : '') + (color ? ' · ' + color : '') }),
        isPreorder(p) && h('span', { class: 'cart-preorder', text: 'Pre-order' }),
        h('div', { class: 'line-meta' },
          h('div', { class: 'qty' },
            h('button', { type: 'button', 'aria-label': 'Decrease quantity of ' + p.name, onclick: () => { setQty(p.id, size || '', color || '', qty - 1); renderDrawer(); } }, icon('minus', 14)),
            h('output', { text: String(qty) }),
            h('button', { type: 'button', 'aria-label': 'Increase quantity of ' + p.name, onclick: () => { setQty(p.id, size || '', color || '', qty + 1); renderDrawer(); } }, icon('plus', 14))),
          h('strong', { text: money(p.price * qty) })),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { setQty(p.id, size || '', color || '', 0); renderDrawer(); }, text: 'Remove' })))));
    foot.replaceChildren(
      h('div', { class: 'sum-row' }, h('span', { class: 'muted', text: 'Items total' }), h('strong', { text: money(cartTotal()) })),
      h('p', { class: 'small muted', text: 'Delivery fee is confirmed on WhatsApp after you order.' }),
      h('a', { class: 'btn btn-wide', href: '#/checkout', onclick: closeDrawer, text: 'Checkout' }));
  }

  function updateCartUI() {
    const n = cartCount();
    for (const id of ['cartCount', 'tabCount']) { const b = $('#' + id); b.textContent = String(n); b.hidden = n === 0; }
    if (drawerOpen()) renderDrawer();
  }

  /* ------------------------------------------------------------------
     Router
  ------------------------------------------------------------------ */
  let renderToken = 0;
  let lastPath = null;
  let lastTrackedRoute = null;

  function go(path, replace) {
    const target = '#' + path;
    if (replace) location.replace(target); else if (location.hash === target) route(); else location.hash = target;
  }

  async function route() {
    if (!state.catalog) return;
    if (orderRefreshTimer !== null) {
      window.clearInterval(orderRefreshTimer);
      orderRefreshTimer = null;
    }
    if (carouselTimer !== null) {
      window.clearInterval(carouselTimer);
      carouselTimer = null;
    }
    if (drawerOpen()) closeDrawer();
    const token = ++renderToken;
    const raw = location.hash.slice(1) || '/';
    if (raw !== lastTrackedRoute) {
      lastTrackedRoute = raw;
      recordStorePageView();
    }
    const [pathPart, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    const seg = pathPart.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const main = $('#main');

    let view, title = "Le-Gacy's Importation", nav = '';
    try {
      switch (seg[0]) {
        case undefined: view = viewHome(); nav = 'home'; break;
        case 'shop': view = viewShop(params); title = 'Shop · Le-Gacy’s Importation'; nav = 'shop'; break;
        case 'product': view = viewProduct(seg[1]); { const p = product(seg[1]); if (p) title = p.name + ' · Le-Gacy’s Importation'; } nav = 'shop'; break;
        case 'checkout': view = viewCheckout(); title = 'Checkout · Le-Gacy’s Importation'; break;
        case 'pay': main.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'muted pad', text: 'Loading your order…' }))); view = await viewPay(seg[1] || ''); title = 'Pay · Le-Gacy’s Importation'; break;
        case 'order': main.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'muted pad', text: 'Loading your order…' }))); view = await viewOrder(seg[1] || ''); title = 'Your order · Le-Gacy’s Importation'; nav = 'track'; break;
        case 'track': view = viewTrack(); title = 'Track order · Le-Gacy’s Importation'; nav = 'track'; break;
        case 'shipping-policy': view = viewPolicy('shipping'); title = 'Shipping Policy · Le-Gacy’s Importation'; break;
        case 'refund-policy': view = viewPolicy('refund'); title = 'Refund Policy · Le-Gacy’s Importation'; break;
        case 'payment': view = viewPaymentInfo(); title = 'Secure payments · Le-Gacy’s Importation'; break;
        default: view = viewNotFound();
      }
    } catch (err) {
      view = h('div', { class: 'wrap page' }, h('div', { class: 'alert alert-err', text: err.message || 'Something went wrong.' }));
    }
    if (token !== renderToken) return; // a newer navigation took over
    main.replaceChildren(...[].concat(view));
    document.title = title;
    document.querySelectorAll('[data-nav]').forEach((a) => {
      if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (lastPath !== pathPart) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
    lastPath = pathPart;
    if (seg[0] === 'order') {
      orderRefreshTimer = window.setInterval(() => refreshTrackedOrder(seg[1] || ''), 60000);
    } else {
      trackedOrderSnapshot = '';
    }
  }

  async function refreshTrackedOrder(ref) {
    if (!ref || orderRefreshRunning || document.hidden || !state.session || state.session.ref !== ref) return;
    orderRefreshRunning = true;
    try {
      const order = await loadOrder(ref);
      if (!order) return;
      const snapshot = order.status + ':' + order.updatedAt;
      if (snapshot !== trackedOrderSnapshot && location.hash === '#/order/' + encodeURIComponent(ref)) {
        trackedOrderSnapshot = snapshot;
        await route();
      }
    } catch (error) {
      console.warn('Order tracking could not refresh:', error.message);
    } finally {
      orderRefreshRunning = false;
    }
  }

  /* ------------------------------------------------------------------
     Boot
  ------------------------------------------------------------------ */
  function boot() {
    document.querySelectorAll('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon, 21)));
    $('.cart-ico').append(icon('bag', 18));
    $('#drawerClose').append(icon('x', 16));
    $('#cartBtn').addEventListener('click', openDrawer);
    $('#tabCart').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen()) closeDrawer(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        const [route, encodedRef] = location.hash.slice(1).split('/').filter(Boolean);
        if (route === 'order' && encodedRef) {
          let ref = encodedRef;
          try { ref = decodeURIComponent(encodedRef); } catch { /* The route handler will show the lookup form. */ }
          refreshTrackedOrder(ref);
        }
      }
    });
    window.addEventListener('hashchange', route);

    state.cart = loadCart();
    state.session = getSession();

    api('/api/catalog').then((data) => {
      state.catalog = data;
      // drop saved cart lines for products that no longer exist
      state.cart = state.cart.filter((i) => product(i.id));
      saveCart();
      renderFooter();
      route();
    }).catch((err) => {
      const retry = h('button', { class: 'btn', type: 'button', onclick: () => location.reload(), text: 'Try again' });
      $('#main').replaceChildren(h('div', { class: 'wrap page' }, h('div', { class: 'empty' }, h('h2', { text: 'The store could not load' }), h('p', { text: err.message }), retry)));
    });
  }

  boot();
})();
