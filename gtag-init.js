/*
======================================
; Title: gtag-init.js
; Author: Red
; Date Created: 12 October 2026
; Last Updated: 26 October 2026
; Description: Starts the Google tag used for Google Merchant Center conversion measurement.
;              Kept in its own file because the pages' Content Security Policy blocks inline scripts.
; Sources Used: Google tag (gtag.js) install snippet from Google Merchant Center
;=====================================
*/

window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());

// Report the page without the Stripe session ID that checkout adds to the URL.
var pageUrl = new URL(window.location.href);
pageUrl.searchParams.delete('session_id');
gtag('config', 'GT-T9CPSQ8R', { page_location: pageUrl.toString() });
