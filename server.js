const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_HOST = 'the-pickled-factory.myshopify.com';
const BLOG_ID = '118414442769';

function shopifyRequest(method, spath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SHOPIFY_HOST,
      path: `/admin/api/2024-10/${spath}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function anthropicRequest(messages, system) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 6000,
      ...(system ? { system } : {}),
      messages
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filename, contentType) {
  try {
    const content = fs.readFileSync(path.join(__dirname, filename));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch(e) {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (pathname === '/' || pathname === '/index.html') return serveFile(res, 'index.html', 'text/html');

  // Blog generate
  if (pathname === '/api/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { messages } = JSON.parse(body);
      const result = await anthropicRequest(messages);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Blog publish
  if (pathname === '/api/publish' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const blog = JSON.parse(body);
      const article = {
        title: blog.title,
        body_html: blog.content_html,
        summary_html: blog.excerpt,
        handle: blog.url_handle,
        tags: (blog.tags || []).join(', '),
        published: true,
        metafields: [
          { namespace: 'global', key: 'title_tag', value: blog.seo_title, type: 'single_line_text_field' },
          { namespace: 'global', key: 'description_tag', value: blog.meta_description, type: 'single_line_text_field' }
        ]
      };
      const result = await shopifyRequest('POST', `blogs/${BLOG_ID}/articles.json`, { article });
      const data = JSON.parse(result.body);
      if (result.status === 201) {
        json(res, 200, {
          success: true,
          article_id: data.article.id,
          handle: data.article.handle,
          admin_url: `https://admin.shopify.com/store/the-pickled-factory/blogs/${BLOG_ID}/articles/${data.article.id}`,
          live_url: `https://www.thepickledfactory.com.au/blogs/news/${data.article.handle}`
        });
      } else {
        json(res, result.status, { error: 'Shopify rejected article', details: data });
      }
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Product research
  if (pathname === '/api/product' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { description } = JSON.parse(body);
      const system = `You are a product research and creation expert for The Pickled Factory (thepickledfactory.com.au), an Australian business selling custom acrylic signs, stamps, embossers, and personalised gifts.`;
      const prompt = `A customer wants to create this product: "${description}"

Research and generate a complete product for The Pickled Factory. Return ONLY valid JSON, no markdown, no backticks:

{
  "product_name": "...",
  "tagline": "...",
  "popular_sizes": [
    {"size": "A5 (148 x 210mm)", "recommended": true, "reason": "..."},
    {"size": "A4 (210 x 297mm)", "recommended": false, "reason": "..."}
  ],
  "recommended_size": "A5 (148 x 210mm)",
  "recommended_dimensions_mm": {"width": 148, "height": 210},
  "material": "3mm Acrylic",
  "finish_options": ["Clear", "Frosted", "Mirror Gold", "Mirror Silver", "Black", "White"],
  "pricing": {
    "cost_estimate_aud": 25,
    "recommended_retail_aud": 65,
    "market_range_aud": "55-85",
    "pricing_notes": "..."
  },
  "shopify": {
    "title": "...",
    "description_html": "...",
    "seo_title": "...",
    "meta_description": "...",
    "url_handle": "...",
    "tags": ["..."],
    "vendor": "The Pickled Factory",
    "product_type": "Acrylic Sign",
    "variants": [
      {"title": "A5 / Clear", "price": "65.00", "sku": "ACR-001-A5-CLR"},
      {"title": "A5 / Frosted", "price": "65.00", "sku": "ACR-001-A5-FRS"},
      {"title": "A4 / Clear", "price": "85.00", "sku": "ACR-001-A4-CLR"}
    ]
  },
  "design": {
    "accent_color_hex": "#c8a96e",
    "sample_content": {
      "heading": "Signature Cocktails",
      "subheading": "The Johnson Wedding · 14 June 2025",
      "items": ["Aperol Spritz", "Hugo Spritz", "Classic Mojito", "Strawberry Daiquiri", "Sparkling Water", "Still Water"],
      "footer": "Please drink responsibly"
    }
  },
  "market_research": {
    "australia_market_notes": "...",
    "unique_selling_points": ["...", "..."]
  }
}`;
      const result = await anthropicRequest([{ role: 'user', content: prompt }], system);
      const d = JSON.parse(result.body);
      if (d.error) { json(res, 500, { error: d.error.message || JSON.stringify(d.error) }); return; }
      const raw = (d.content || []).map(c => c.text || '').join('');
      const product = JSON.parse(raw.replace(/```json|```/g, '').trim());
      json(res, 200, product);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Publish product — with full error detail
  if (pathname === '/api/publish-product' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { product, imageBase64 } = JSON.parse(body);

      // First check what scopes our token has by hitting shop endpoint
      const shopCheck = await shopifyRequest('GET', 'shop.json');
      console.log('Shop check status:', shopCheck.status);

      // Build product — keep it minimal to avoid scope issues
      const shopifyProduct = {
        title: product.shopify.title,
        body_html: product.shopify.description_html,
        vendor: product.shopify.vendor || 'The Pickled Factory',
        product_type: product.shopify.product_type || 'Acrylic Sign',
        tags: (product.shopify.tags || []).join(', '),
        status: 'draft',
        variants: (product.shopify.variants || []).map(v => ({
          option1: v.title,
          price: v.price,
          sku: v.sku
        })),
        options: [{ name: 'Style' }]
      };

      console.log('Sending product:', JSON.stringify(shopifyProduct).slice(0, 500));
      const result = await shopifyRequest('POST', 'products.json', { product: shopifyProduct });
      console.log('Product result status:', result.status);
      console.log('Product result body:', result.body.slice(0, 1000));

      const data = JSON.parse(result.body);

      if (result.status === 201) {
        const productId = data.product.id;

        // Upload image separately if provided
        if (imageBase64) {
          const imgResult = await shopifyRequest('POST', `products/${productId}/images.json`, {
            image: { attachment: imageBase64, filename: (product.shopify.url_handle || 'product') + '.png' }
          });
          console.log('Image upload status:', imgResult.status);
        }

        json(res, 200, {
          success: true,
          product_id: productId,
          admin_url: `https://admin.shopify.com/store/the-pickled-factory/products/${productId}`,
          live_url: `https://www.thepickledfactory.com.au/products/${data.product.handle}`
        });
      } else {
        // Return full error detail
        json(res, 200, {
          success: false,
          error: 'Shopify rejected product',
          status: result.status,
          details: data
        });
      }
    } catch(e) {
      console.error('Publish product error:', e);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // Test
  if (pathname === '/api/test') {
    try {
      const shop = await shopifyRequest('GET', 'shop.json');
      const shopData = JSON.parse(shop.body);
      json(res, 200, {
        shopify: shop.status === 200 ? 'connected' : 'failed',
        shop_name: shopData.shop?.name,
        anthropic_key: ANTHROPIC_API_KEY ? 'set' : 'missing',
        shopify_token: SHOPIFY_TOKEN ? 'set' : 'missing'
      });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Running on port ${PORT}`));
