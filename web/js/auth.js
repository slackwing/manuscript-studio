// URLs are relative so the server's <base href> controls the path prefix.

// Returns the session JSON, or redirects to login and returns null if unauthenticated.
async function checkAuth() {
  try {
    const response = await fetch('api/session', {
      credentials: 'include'
    });

    if (!response.ok) {
      window.location.href = 'login.html';
      return null;
    }

    const session = await response.json();
    return session;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = 'login.html';
    return null;
  }
}

async function logout() {
  try {
    await fetch('api/logout', {
      method: 'POST',
      credentials: 'include'
    });
  } catch (error) {
    console.error('Logout failed:', error);
  } finally {
    window.location.href = 'login.html';
  }
}

async function getSession() {
  try {
    const response = await fetch('api/session', {
      credentials: 'include'
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to get session:', error);
    return null;
  }
}

function getCSRFToken() {
  return sessionStorage.getItem('csrf_token');
}

// fetch() with credentials and an X-CSRF-Token header on state-changing
// methods. Redirects to login on 401 so an expired session isn't silent.
async function authenticatedFetch(url, options = {}) {
  options.credentials = 'include';

  if (options.method && ['POST', 'PUT', 'DELETE'].includes(options.method.toUpperCase())) {
    const csrfToken = getCSRFToken();
    if (csrfToken) {
      options.headers = options.headers || {};
      options.headers['X-CSRF-Token'] = csrfToken;
    }
  }

  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.href = 'login.html';
  }
  return response;
}

// Fetch JSON; on non-OK or non-JSON responses throws Error with a truncated
// body in .message — friendlier to debug than a bare JSON.parse error.
async function fetchJSON(url, options = {}, authenticated = true) {
  const response = authenticated
    ? await authenticatedFetch(url, options)
    : await fetch(url, options);

  if (!response.ok) {
    let body = '';
    try { body = (await response.text()).slice(0, 500); } catch (_) {}
    const err = new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    let body = '';
    try { body = (await response.text()).slice(0, 500); } catch (_) {}
    throw new Error(`Expected JSON, got ${contentType || 'no content-type'}: ${body}`);
  }

  return response.json();
}
