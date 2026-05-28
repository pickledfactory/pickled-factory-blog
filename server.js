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

function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SHOPIFY_HOST,
      path: `/admin/api/2024-10/${path}`,
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

function anthropicRequest(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Serve index.html
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Generate blog
  if (pathname === '/api/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { messages } = JSON.parse(body);
      const result = await anthropicRequest(messages);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // Publish to Shopify
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
        json(res, result.status, { error: 'Shopify rejected the article', details: data });
      }
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // Test endpoint
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
    } catch(e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Blog publisher running on port ${PORT}`));
