// Authentication utilities

const API_URL = window.location.origin;

/**
 * Check if user is authenticated
 * Redirects to login page if not authenticated
 */
async function checkAuth() {
  try {
    const response = await fetch(`${API_URL}/api/session`, {
      credentials: 'include'
    });

    if (!response.ok) {
      // Not logged in, redirect to login page
      window.location.href = '/login.html';
      return null;
    }

    const session = await response.json();
    return session;
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/login.html';
    return null;
  }
}

/**
 * Logout the current user
 */
async function logout() {
  try {
    await fetch(`${API_URL}/api/logout`, {
      method: 'POST',
      credentials: 'include'
    });
  } catch (error) {
    console.error('Logout failed:', error);
  } finally {
    window.location.href = '/login.html';
  }
}

/**
 * Get current session info
 */
async function getSession() {
  try {
    const response = await fetch(`${API_URL}/api/session`, {
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
