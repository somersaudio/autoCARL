<?php
// AUTOcarl SSW relay — exists ONLY because ctts.ctus.com's TLS handshake
// (small DH key) is refused by Cloudflare Workers' outbound fetch, while
// this host's curl can be told to accept it. It forwards exactly one kind
// of request: authenticated JSON POSTs from our own Worker, to SSW's host,
// nothing else. No logging, no storage.

header('Cache-Control: no-store');

$SECRET = trim(@file_get_contents(__DIR__ . '/relay-key.txt') ?: '');
if ($SECRET === '') { http_response_code(500); exit; }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST'
    || !hash_equals($SECRET, $_SERVER['HTTP_X_RELAY_KEY'] ?? '')) {
    http_response_code(403);
    exit;
}

$req = json_decode(file_get_contents('php://input'), true);
$url = isset($req['url']) ? (string)$req['url'] : '';
if (!preg_match('#^https://ctts\.ctus\.com/#i', $url)) {
    http_response_code(400);
    exit;
}

$headers = [];
foreach (($req['headers'] ?? []) as $k => $v) {
    if (strcasecmp($k, 'host') === 0 || strcasecmp($k, 'content-length') === 0) continue;
    $headers[] = $k . ': ' . $v;
}

$respHeaders = [];
$setCookies = [];
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => strtoupper((string)($req['method'] ?? 'GET')),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,          // the Worker walks redirects itself
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT        => 40,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_SSL_CIPHER_LIST => 'DEFAULT@SECLEVEL=1',   // SSW's legacy DH key
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$respHeaders, &$setCookies) {
        $trim = trim($line);
        $colon = strpos($trim, ':');
        if ($colon !== false) {
            $name = strtolower(substr($trim, 0, $colon));
            $val = trim(substr($trim, $colon + 1));
            if ($name === 'set-cookie') $setCookies[] = $val;
            else $respHeaders[$name] = $val;
        }
        return strlen($line);
    },
]);
if (isset($req['body']) && $req['body'] !== null) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, (string)$req['body']);
}

$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$err  = curl_errno($ch);
curl_close($ch);

header('Content-Type: application/json');
if ($err !== 0 || $body === false) {
    http_response_code(502);
    echo json_encode(['error' => 'ssw unreachable']);
    exit;
}
echo json_encode([
    'status'     => $code,
    'headers'    => $respHeaders,
    'setCookies' => $setCookies,
    'bodyB64'    => base64_encode($body),
]);
