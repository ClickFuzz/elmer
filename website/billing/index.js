'use strict';

document.addEventListener('DOMContentLoaded', function () {
  const session = getSession();
  if (isSessionValid(session)) {
    window.location.replace('subscription.html');
  } else {
    clearSession();
    window.location.replace('login.html');
  }
});
