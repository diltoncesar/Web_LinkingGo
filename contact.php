<?php
header('Content-Type: application/json; charset=utf-8');

// ── Only accept POST ───────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.']);
    exit;
}

// ── SMTP credentials — fill in after creating the mailbox ──
define('SMTP_HOST', 'smtp.hostinger.com');
define('SMTP_PORT', 465);          // 465 = SSL  |  587 = TLS
define('SMTP_USER', 'contato@linkinggo.com.br');
define('SMTP_PASS', 'Natalia*0123');
define('MAIL_TO',   'contato@linkinggo.com.br');

// ── Sanitize inputs ────────────────────────────────────────
function clean(string $value): string {
    return htmlspecialchars(strip_tags(trim($value)), ENT_QUOTES, 'UTF-8');
}

$nome     = clean($_POST['nome']     ?? '');
$empresa  = clean($_POST['empresa']  ?? '');
$email    = clean($_POST['email']    ?? '');
$drivers  = clean($_POST['drivers']  ?? '');
$mensagem = clean($_POST['mensagem'] ?? '');

// ── Validate ───────────────────────────────────────────────
if (!$nome || !$empresa || !$email || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Preencha nome, empresa e e-mail corretamente.']);
    exit;
}

// ── Build e-mail body ──────────────────────────────────────
$subject = "Nova solicitação de demonstração — {$empresa}";

$body  = "Nova solicitação de demonstração recebida pelo site linkinggo.com.br\r\n";
$body .= str_repeat("─", 50) . "\r\n\r\n";
$body .= "Nome:            {$nome}\r\n";
$body .= "Empresa:         {$empresa}\r\n";
$body .= "E-mail:          {$email}\r\n";
$body .= "Nº de motoristas:{$drivers}\r\n\r\n";
if ($mensagem) {
    $body .= "Mensagem:\r\n{$mensagem}\r\n\r\n";
}
$body .= str_repeat("─", 50) . "\r\n";
$body .= "Enviado em: " . date('d/m/Y H:i') . " (horário do servidor)\r\n";

// ── Send via SMTP (no dependencies) ───────────────────────
function smtp_send(string $to, string $subject, string $body, string $replyTo): bool {
    $errno = 0; $errstr = '';

    // SSL connection
    $socket = fsockopen('ssl://' . SMTP_HOST, SMTP_PORT, $errno, $errstr, 15);
    if (!$socket) {
        error_log("[LinkingGo contact] SMTP connect failed: {$errstr}");
        return false;
    }

    $read = function() use ($socket): string {
        $res = '';
        while ($line = fgets($socket, 515)) {
            $res .= $line;
            if (substr($line, 3, 1) === ' ') break;
        }
        return $res;
    };
    $send = function(string $cmd) use ($socket): void {
        fputs($socket, $cmd . "\r\n");
    };

    $read(); // 220 greeting

    $send('EHLO linkinggo.com.br');
    $read();

    $send('AUTH LOGIN');
    $read();

    $send(base64_encode(SMTP_USER));
    $read();

    $send(base64_encode(SMTP_PASS));
    $resp = $read();
    if (strpos($resp, '235') === false) {
        error_log("[LinkingGo contact] SMTP auth failed: {$resp}");
        fclose($socket);
        return false;
    }

    $send('MAIL FROM:<' . SMTP_USER . '>');
    $read();

    $send('RCPT TO:<' . $to . '>');
    $read();

    $send('DATA');
    $read();

    $headers  = "From: LinkingGo <" . SMTP_USER . ">\r\n";
    $headers .= "To: {$to}\r\n";
    $headers .= "Reply-To: {$replyTo}\r\n";
    $headers .= "Subject: {$subject}\r\n";
    $headers .= "MIME-Version: 1.0\r\n";
    $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $headers .= "Date: " . date('r') . "\r\n";

    $send($headers . "\r\n" . $body . "\r\n.");
    $resp = $read();

    $send('QUIT');
    fclose($socket);

    return strpos($resp, '250') !== false;
}

// ── Fire ───────────────────────────────────────────────────
$sent = smtp_send(MAIL_TO, $subject, $body, $email);

if ($sent) {
    echo json_encode(['success' => true,  'message' => 'Mensagem enviada! Entraremos em contato em breve.']);
} else {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Erro ao enviar. Tente novamente ou fale pelo WhatsApp.']);
}
