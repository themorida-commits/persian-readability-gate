#!/usr/bin/env bash
# تست‌های گیت خوانایی فارسی: سالم باید پاس شود، خراب باید با همان ۴ تخلف فیل شود،
# و نسخهٔ فونت‌درشت باید با R8 (حاشیهٔ امن) بیفتد.
set -u
cd "$(dirname "$0")/.."
GATE="node gate/fa_readability_gate.mjs"
fail=0

echo "── تست ۱: کلیپ سالم ← انتظار PASS"
if $GATE clip > /tmp/gate-t1.log 2>&1; then echo "  ✓ PASS شد"; else echo "  ✗ FAIL شد (نباید)"; cat /tmp/gate-t1.log; fail=1; fi

echo "── تست ۲: کلیپ عمداً خراب ← انتظار FAIL با R1×2 و R2 و R5"
if $GATE tests/clip-broken > /tmp/gate-t2.log 2>&1; then echo "  ✗ PASS شد (نباید)"; fail=1
else
  ok=1
  for pat in "R1 #subtitle" "R1 #badge" "R2 #badge" "R5 #badge"; do
    grep -q "$pat" /tmp/gate-t2.log || { echo "  ✗ تخلف گمشده: $pat"; ok=0; }
  done
  [ $ok -eq 1 ] && echo "  ✓ FAIL با هر ۴ تخلف مورد انتظار"
  [ $ok -eq 0 ] && fail=1
fi

echo "── تست ۳: رگرسیون R8 — تایتل ۸۸px ← انتظار FAIL فقط با R8"
rm -rf /tmp/clip-r8 && cp -r clip /tmp/clip-r8 && sed -i 's/font-size:72px/font-size:88px/' /tmp/clip-r8/index.html
if $GATE /tmp/clip-r8 > /tmp/gate-t3.log 2>&1; then echo "  ✗ PASS شد (نباید)"; fail=1
else grep -q "R8 #title" /tmp/gate-t3.log && echo "  ✓ FAIL با R8" || { echo "  ✗ R8 گرفته نشد"; fail=1; }; fi
rm -rf /tmp/clip-r8

[ $fail -eq 0 ] && echo "═══ همهٔ تست‌ها سبز" || echo "═══ تست قرمز داریم"
exit $fail
