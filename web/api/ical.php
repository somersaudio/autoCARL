<?php
// AUTOcarl mobile — calendar proxy.
//
// Browsers can't fetch CARL's calendar cross-origin, so this forwards the
// request server-side. It is deliberately NOT an open proxy: only HTTPS
// URLs on CARL's calendar host are allowed, the URL (which embeds the
// user's personal token) is never logged or stored, and responses are
// never cached server-side.

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$u = isset($_GET['u']) ? (string)$_GET['u'] : '';

// Same shape the desktop app validates: https://calendar.<...>carl.ctus.live/...
if (!preg_match('#^https://calendar\.[a-z0-9.\-]*carl\.ctus\.live/#i', $u)) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not a CARL calendar link.';
    exit;
}

$ch = curl_init($u);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 3,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT        => 20,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_USERAGENT      => 'AUTOcarl-mobile/1',
    // Calendars are ~10 KB; anything huge is not a calendar.
    CURLOPT_BUFFERSIZE     => 65536,
    CURLOPT_NOPROGRESS     => false,
    CURLOPT_PROGRESSFUNCTION => function ($ch, $dltotal, $dlnow) {
        return ($dlnow > 2000000) ? 1 : 0;   // abort past 2 MB
    },
]);

$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$err  = curl_errno($ch);
curl_close($ch);

if ($err !== 0 || $body === false) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'CARL did not answer.';
    exit;
}

http_response_code($code === 200 ? 200 : 502);
header('Content-Type: text/calendar; charset=utf-8');
echo $body;
