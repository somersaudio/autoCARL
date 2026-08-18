<?php
// AUTOcarl expense mailer — sends the CT expense-report email (form +
// receipt PDFs attached) through iCloud's SMTP as the address configured in
// mail-creds.txt ("address|app-specific-password"). iCloud is where
// somersaudio.com's mail lives (MX + SPF), so this is the one route that
// delivers cleanly; Hostinger's own mail() would fail SPF.
//
// Called only by the autocarl-api Worker (same shared key as relay.php).
// The crew member reviews the message in the app before anything sends —
// this endpoint never composes on its own.

header('Cache-Control: no-store');
header('Content-Type: application/json');

$SECRET = trim(@file_get_contents(__DIR__ . '/relay-key.txt') ?: '');
if ($SECRET === '') { http_response_code(500); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST'
    || !hash_equals($SECRET, $_SERVER['HTTP_X_RELAY_KEY'] ?? '')) {
    http_response_code(403);
    exit;
}

$CREDS = trim(@file_get_contents(__DIR__ . '/mail-creds.txt') ?: '');
if ($CREDS === '' || strpos($CREDS, '|') === false) {
    http_response_code(503);
    echo json_encode(['error' => "Email sending isn't set up yet — ask John to finish the mail configuration."]);
    exit;
}
list($FROM, $APPPW) = array_map('trim', explode('|', $CREDS, 2));

$req = json_decode(file_get_contents('php://input'), true);
if (!is_array($req)) { http_response_code(400); echo json_encode(['error' => 'bad request']); exit; }

$emailRe = '/^[^@\s]+@[^@\s]+\.[^@\s]+$/';
$clean_list = function ($v, $max) use ($emailRe) {
    $out = [];
    foreach ((array)$v as $r) {
        $r = trim((string)$r);
        if ($r !== '' && preg_match($emailRe, $r)) $out[] = $r;
    }
    return array_slice(array_values(array_unique($out)), 0, $max);
};
$to = $clean_list($req['to'] ?? [], 6);
$cc = $clean_list($req['cc'] ?? [], 2);
if (!$to) { http_response_code(400); echo json_encode(['error' => 'at least one valid recipient is required']); exit; }

$replyTo = trim((string)($req['replyTo'] ?? ''));
if ($replyTo !== '' && !preg_match($emailRe, $replyTo)) $replyTo = '';
$subject = substr(preg_replace('/[\r\n]+/', ' ', trim((string)($req['subject'] ?? ''))), 0, 200);
if ($subject === '') $subject = 'Expense Report';
$body = substr((string)($req['body'] ?? ''), 0, 5000);
$senderName = substr(preg_replace('/[\r\n"<>]+/', ' ', trim((string)($req['senderName'] ?? ''))), 0, 60);

$atts = [];
$totalBytes = 0;
foreach ((array)($req['attachments'] ?? []) as $a) {
    if (!is_array($a)) continue;
    $name = preg_replace('/[\/\\\\:*?"<>|\r\n]+/', '-', trim((string)($a['name'] ?? '')));
    if ($name === '') $name = 'attachment.pdf';
    $data = base64_decode((string)($a['dataB64'] ?? ''), true);
    if ($data === false || strlen($data) === 0) continue;
    $totalBytes += strlen($data);
    if ($totalBytes > 20 * 1024 * 1024) {
        http_response_code(413);
        echo json_encode(['error' => 'attachments too large — keep the report under about 20MB']);
        exit;
    }
    $atts[] = [$name, $data];
    if (count($atts) >= 40) break;
}

// ---- MIME assembly ----
$boundary = 'ac-' . bin2hex(random_bytes(12));
$fromHeader = $senderName !== ''
    ? '"' . $senderName . ' via AUTOcarl" <' . $FROM . '>'
    : 'AUTOcarl <' . $FROM . '>';
$headers  = 'From: ' . $fromHeader . "\r\n";
$headers .= 'To: ' . implode(', ', $to) . "\r\n";
if ($cc) $headers .= 'Cc: ' . implode(', ', $cc) . "\r\n";
if ($replyTo !== '') $headers .= 'Reply-To: ' . $replyTo . "\r\n";
$headers .= 'Subject: =?UTF-8?B?' . base64_encode($subject) . "?=\r\n";
$headers .= "MIME-Version: 1.0\r\n";
$headers .= 'Date: ' . date(DATE_RFC2822) . "\r\n";
$headers .= 'Message-ID: <' . bin2hex(random_bytes(10)) . '@somersaudio.com>' . "\r\n";
$headers .= 'Content-Type: multipart/mixed; boundary="' . $boundary . '"' . "\r\n";

$mime  = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n";
$mime .= chunk_split(base64_encode($body));
foreach ($atts as [$name, $data]) {
    $mime .= "--$boundary\r\n"
           . "Content-Type: application/pdf; name=\"$name\"\r\n"
           . "Content-Disposition: attachment; filename=\"$name\"\r\n"
           . "Content-Transfer-Encoding: base64\r\n\r\n"
           . chunk_split(base64_encode($data));
}
$mime .= "--$boundary--\r\n";

$err = smtp_send('smtp.mail.me.com', 587, $FROM, $APPPW, array_merge($to, $cc), $headers . "\r\n" . $mime);
if ($err !== null) { http_response_code(502); echo json_encode(['error' => $err]); exit; }
echo json_encode(['ok' => true, 'to' => $to, 'cc' => $cc]);

// Minimal SMTP client: EHLO, STARTTLS, AUTH PLAIN, one message. iCloud
// requires the authenticated address (or one of its aliases) as sender.
function smtp_send($host, $port, $user, $pass, $rcpts, $data) {
    $fp = @stream_socket_client("tcp://$host:$port", $errno, $errstr, 20);
    if (!$fp) return "mail server unreachable ($errstr)";
    stream_set_timeout($fp, 30);
    $read = function () use ($fp) {
        $out = '';
        while (($line = fgets($fp, 2048)) !== false) {
            $out .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break;
        }
        return $out;
    };
    $cmd = function ($c) use ($fp, $read) { fwrite($fp, $c . "\r\n"); return $read(); };
    $ok = function ($resp, $code) { return strpos($resp, (string)$code) === 0; };

    if (!$ok($read(), 220)) return 'mail server refused the connection';
    if (!$ok($cmd('EHLO somersaudio.com'), 250)) return 'mail server rejected EHLO';
    if (!$ok($cmd('STARTTLS'), 220)) return 'mail server refused TLS';
    if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) return 'TLS negotiation failed';
    if (!$ok($cmd('EHLO somersaudio.com'), 250)) return 'mail server rejected EHLO after TLS';
    if (!$ok($cmd('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $pass)), 235)) {
        return 'mail sign-in failed — the app-specific password may be wrong or revoked';
    }
    if (!$ok($cmd('MAIL FROM:<' . $user . '>'), 250)) return 'sender refused by the mail server';
    foreach ($rcpts as $r) {
        if (!$ok($cmd('RCPT TO:<' . $r . '>'), 250)) return "recipient refused: $r";
    }
    if (!$ok($cmd('DATA'), 354)) return 'mail server refused the message';
    fwrite($fp, preg_replace('/^\./m', '..', $data) . "\r\n.\r\n");
    if (!$ok($read(), 250)) return 'message rejected by the mail server';
    $cmd('QUIT');
    fclose($fp);
    return null;
}
