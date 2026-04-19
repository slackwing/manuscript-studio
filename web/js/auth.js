// Authentication utilities
// All URLs are relative so <base href> set by the server handles the path prefix.

/**
 * Check if user is authenticated
 * Redirects to login page if not authenticated
 */
async function checkAuth() {
  try {
    const response = await fetch('api/session', {
      credentials: 'include'
    });

    if (!response.ok) {
      // Not logged in, redirect to login page
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

/**
 * Logout the current user
 */
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

/**
 * Get current session info
 */
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

/**
 * Get CSRF token from sessionStorage
 */
function getCSRFToken() {
  return sessionStorage.getItem('csrf_token');
}

/**
 * Make an authenticated fetch request with CSRF token
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function authenticatedFetch(url, options = {}) {
  // Add credentials
  options.credentials = 'include';

  // Add CSRF token for state-changing requests
  if (options.method && ['POST', 'PUT', 'DELETE'].includes(options.method.toUpperCase())) {
    const csrfToken = getCSRFToken();
    if (csrfToken) {
      options.headers = options.headers || {};
      options.headers['X-CSRF-Token'] = csrfToken;
    }
  }

  return fetch(url, options);
}

/**
 * Fetch and parse JSON, with defensive checks for non-OK responses and
 * non-JSON Content-Type. Throws an Error whose .message includes the
 * server's response body (truncated) when the server returned HTML or
 * plain text — this is much friendlier to debug than a JSON.parse error.
 *
 * @param {string} url
 * @param {object} options - same shape as fetch options
 * @param {boolean} [authenticated=true] - if true, uses authenticatedFetch
 * @returns {Promise<any>} parsed JSON body
 */
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
