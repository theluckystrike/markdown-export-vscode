# Raw HTML with scripts

<script>document.title = 'PWNED'; document.body.innerHTML = 'HACKED';</script>

<img src="nope.png" onerror="document.body.innerHTML='HACKED2'">

<a href="javascript:alert(1)">click me</a> and <iframe src="https://example.com"></iframe>

<div onclick="alert(2)">A div with a click handler.</div>

<svg><script>alert(3)</script></svg>

Text after the scripts stays.
