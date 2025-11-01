const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios');
const { URL } = require('url');

// Static files
app.use(express.static('public'));

// Generate random 6-character session ID
function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Store active sessions
const sessions = new Map();

// Proxy cache
const proxyCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Helper function to rewrite URLs in HTML/CSS/JS
function rewriteUrls(content, originalUrl, contentType) {
  if (!content || typeof content !== 'string') return content;

  try {
    const baseUrl = new URL(originalUrl);
    const origin = baseUrl.origin;
    const proxyBase = '/proxy?url=';

    // For HTML content
    if (contentType && contentType.includes('text/html')) {
      // Rewrite src, href, action attributes
      content = content.replace(
        /(src|href|action|data-src|data-href)=["'](?!data:)(?!https?:\/\/)(?!\/\/)(.*?)["']/gi,
        (match, attr, url) => {
          if (url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:')) {
            return match;
          }
          const absoluteUrl = new URL(url, originalUrl).href;
          return `${attr}="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
        }
      );

      // Rewrite absolute URLs (with http/https)
      content = content.replace(
        /(src|href|action|data-src|data-href)=["'](https?:\/\/.*?)["']/gi,
        (match, attr, url) => {
          return `${attr}="${proxyBase}${encodeURIComponent(url)}"`;
        }
      );

      // Rewrite protocol-relative URLs (//example.com)
      content = content.replace(
        /(src|href|action|data-src|data-href)=["'](\/\/.*?)["']/gi,
        (match, attr, url) => {
          const absoluteUrl = baseUrl.protocol + url;
          return `${attr}="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
        }
      );

      // Rewrite background images in style attributes
      content = content.replace(
        /style=["']([^"']*url\([^)]+\)[^"']*)["']/gi,
        (match, styleContent) => {
          const rewrittenStyle = rewriteCssUrls(styleContent, originalUrl);
          return `style="${rewrittenStyle}"`;
        }
      );

      // Inject base tag removal script (to prevent conflicts)
      const injectedScript = `
        <script>
          // Remove base tag if exists to prevent conflicts
          document.querySelectorAll('base').forEach(el => el.remove());
          
          // Intercept fetch requests
          const originalFetch = window.fetch;
          window.fetch = function(url, options) {
            if (typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('blob:')) {
              if (!url.startsWith('http') && !url.startsWith('//')) {
                url = new URL(url, '${originalUrl}').href;
              }
              if (url.startsWith('http') || url.startsWith('//')) {
                url = '/proxy?url=' + encodeURIComponent(url);
              }
            }
            return originalFetch.call(this, url, options);
          };

          // Intercept XMLHttpRequest
          const OriginalXHR = window.XMLHttpRequest;
          window.XMLHttpRequest = function() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;
            xhr.open = function(method, url, ...args) {
              if (typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('blob:')) {
                if (!url.startsWith('http') && !url.startsWith('//')) {
                  url = new URL(url, '${originalUrl}').href;
                }
                if (url.startsWith('http') || url.startsWith('//')) {
                  url = '/proxy?url=' + encodeURIComponent(url);
                }
              }
              return originalOpen.call(this, method, url, ...args);
            };
            return xhr;
          };
        </script>
      `;

      if (content.includes('</head>')) {
        content = content.replace('</head>', `${injectedScript}</head>`);
      } else if (content.includes('<html>')) {
        content = content.replace('<html>', `<html><head>${injectedScript}</head>`);
      } else {
        content = injectedScript + content;
      }
    }

    // For CSS content
    if (contentType && contentType.includes('text/css')) {
      content = rewriteCssUrls(content, originalUrl);
    }

    // For JavaScript - rewrite dynamic imports and fetch calls
    if (contentType && (contentType.includes('javascript') || contentType.includes('application/json'))) {
      // This is tricky and may break some sites, so be careful
      // Only rewrite obvious URL patterns
      content = content.replace(
        /(["'`])(https?:\/\/[^"'`]+)(["'`])/g,
        (match, q1, url, q2) => {
          return `${q1}${proxyBase}${encodeURIComponent(url)}${q2}`;
        }
      );
    }

    return content;
  } catch (err) {
    console.error('Error rewriting URLs:', err);
    return content;
  }
}

// Helper function to rewrite CSS URLs
function rewriteCssUrls(css, originalUrl) {
  const proxyBase = '/proxy?url=';
  
  // Rewrite url() in CSS
  css = css.replace(
    /url\s*\(\s*(['"]?)(?!data:)(?!https?:\/\/)([^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      try {
        const absoluteUrl = new URL(url.trim(), originalUrl).href;
        return `url(${quote}${proxyBase}${encodeURIComponent(absoluteUrl)}${quote})`;
      } catch (e) {
        return match;
      }
    }
  );

  // Rewrite absolute URLs
  css = css.replace(
    /url\s*\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      return `url(${quote}${proxyBase}${encodeURIComponent(url)}${quote})`;
    }
  );

  // Rewrite protocol-relative URLs
  css = css.replace(
    /url\s*\(\s*(['"]?)(\/\/[^'")]+)\1\s*\)/gi,
    (match, quote, url) => {
      const baseUrl = new URL(originalUrl);
      const absoluteUrl = baseUrl.protocol + url;
      return `url(${quote}${proxyBase}${encodeURIComponent(absoluteUrl)}${quote})`;
    }
  );

  return css;
}

// Enhanced proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  if (!targetUrl) {
    return res.status(400).send('URL parameter is required');
  }

  try {
    // Add protocol if missing
    let fullUrl = targetUrl;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }

    // Validate URL
    const parsedUrl = new URL(fullUrl);
    
    // Check cache
    const cacheKey = fullUrl;
    const cached = proxyCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('✓ Cache hit:', fullUrl);
      res.set(cached.headers);
      return res.send(cached.data);
    }

    // Fetch the resource
    console.log('→ Proxying:', fullUrl);
    const response = await axios.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': parsedUrl.origin,
        'Origin': parsedUrl.origin,
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none'
      },
      maxRedirects: 5,
      timeout: 15000,
      responseType: 'arraybuffer', // Get binary data
      validateStatus: (status) => status < 500 // Accept 4xx codes
    });

    const contentType = response.headers['content-type'] || '';
    let content = response.data;

    // Convert binary to string for text content
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/javascript') ||
                          contentType.includes('application/json') ||
                          contentType.includes('application/xml');

    if (isTextContent) {
      content = content.toString('utf-8');
      // Rewrite URLs in content
      content = rewriteUrls(content, fullUrl, contentType);
    }

    // Prepare response headers
    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'X-Proxied-By': 'TV-Remote-Proxy',
      'X-Original-URL': fullUrl
    };

    // Cache the response (only cache successful responses)
    if (response.status >= 200 && response.status < 300) {
      proxyCache.set(cacheKey, {
        data: content,
        headers: headers,
        timestamp: Date.now()
      });

      // Clean old cache entries
      if (proxyCache.size > 200) {
        const oldestKey = proxyCache.keys().next().value;
        proxyCache.delete(oldestKey);
      }
    }

    res.set(headers);
    res.status(response.status).send(content);

    console.log('✓ Success:', fullUrl, `(${contentType})`);

  } catch (error) {
    console.error('✗ Proxy error:', error.message);
    
    const errorHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Proxy Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            display: flex; 
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
            color: #e5e5e5; 
            padding: 20px;
          }
          .error { 
            max-width: 500px;
            width: 100%;
            padding: 40px; 
            background: rgba(26, 26, 26, 0.8);
            backdrop-filter: blur(10px);
            border-radius: 24px; 
            border: 1px solid rgba(255,255,255,0.1);
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            text-align: center;
          }
          .icon { font-size: 64px; margin-bottom: 20px; }
          h1 { 
            color: #ef4444; 
            margin-bottom: 16px; 
            font-size: 24px;
            font-weight: 700;
          }
          .message { 
            color: #a0a0a0; 
            margin-bottom: 20px;
            line-height: 1.6;
          }
          .url { 
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.3);
            padding: 12px;
            border-radius: 12px;
            color: #3b82f6;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            word-break: break-all;
            margin-top: 20px;
          }
          .code {
            background: rgba(0,0,0,0.3);
            padding: 8px 12px;
            border-radius: 8px;
            color: #f59e0b;
            font-family: monospace;
            display: inline-block;
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
        <div class="error">
          <div class="icon">⚠️</div>
          <h1>${error.response ? error.response.status + ' Error' : 'Connection Error'}</h1>
          <p class="message">
            ${error.response 
              ? `Server responded with error: <strong>${error.response.statusText}</strong>` 
              : `Could not connect to the server: <strong>${error.message}</strong>`
            }
          </p>
          ${error.code ? `<div class="code">Error Code: ${error.code}</div>` : ''}
          <div class="url">${targetUrl}</div>
        </div>
      </body>
      </html>
    `;

    res.status(error.response?.status || 500)
       .set('Content-Type', 'text/html')
       .send(errorHtml);
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

app.get('/phone/:sessionId?', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'phone.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);

  socket.on('create-session', () => {
    const sessionId = generateSessionId();
    sessions.set(sessionId, {
      tvSocketId: socket.id,
      phoneSocketId: null,
      createdAt: Date.now()
    });
    
    socket.join(sessionId);
    socket.emit('session-created', sessionId);
    console.log('📺 Session created:', sessionId);
  });

  socket.on('join-session', (sessionId) => {
    const session = sessions.get(sessionId);
    
    if (session) {
      session.phoneSocketId = socket.id;
      socket.join(sessionId);
      socket.emit('session-joined', { success: true });
      io.to(session.tvSocketId).emit('phone-connected');
      console.log('📱 Phone joined:', sessionId);
    } else {
      socket.emit('session-joined', { success: false, error: 'Session not found' });
    }
  });

  socket.on('open-link', (data) => {
    const { sessionId, url, useProxy } = data;
    const session = sessions.get(sessionId);
    
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('open-link', { url, useProxy });
      console.log(`🔗 Link sent (proxy: ${useProxy}):`, url);
    }
  });

  socket.on('fullscreen', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('fullscreen');
    }
  });

  socket.on('exit-fullscreen', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('exit-fullscreen');
    }
  });

  socket.on('refresh', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('refresh');
    }
  });

  socket.on('go-back', (sessionId) => {
    const session = sessions.get(sessionId);
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('go-back');
    }
  });

  socket.on('iframe-error', (data) => {
    const { sessionId, url } = data;
    const session = sessions.get(sessionId);
    if (session && session.phoneSocketId) {
      io.to(session.phoneSocketId).emit('iframe-blocked', url);
    }
  });

  socket.on('open-in-new-tab-on-tv', (data) => {
    const { sessionId, url } = data;
    const session = sessions.get(sessionId);
    if (session && session.tvSocketId) {
      io.to(session.tvSocketId).emit('open-in-new-tab', url);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected:', socket.id);
    
    for (const [sessionId, session] of sessions.entries()) {
      if (session.tvSocketId === socket.id) {
        if (session.phoneSocketId) {
          io.to(session.phoneSocketId).emit('tv-disconnected');
        }
        sessions.delete(sessionId);
        console.log('🗑️ Session deleted:', sessionId);
      } else if (session.phoneSocketId === socket.id) {
        session.phoneSocketId = null;
        io.to(session.tvSocketId).emit('phone-disconnected');
      }
    }
  });
});

// Cleanup intervals
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > 3600000) {
      sessions.delete(sessionId);
      console.log('⏰ Session expired:', sessionId);
    }
  }
}, 300000);

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of proxyCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      proxyCache.delete(key);
    }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 TV Remote Server`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📺 TV Interface:      http://localhost:${PORT}`);
  console.log(`🔄 Reverse Proxy:     http://localhost:${PORT}/proxy?url=<url>`);
  console.log(`⚡ Socket.IO:         Enabled`);
  console.log(`💾 Cache Duration:    ${CACHE_DURATION / 1000}s`);
  console.log(`${'='.repeat(60)}\n`);
});