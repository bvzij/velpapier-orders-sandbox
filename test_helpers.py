# Run: python3 vps-reference/tests/test_helpers.py  (no installs needed; FIX_LOG 6.5)
import os, re, sys
# Load just the helper functions without importing fitz/rapidfuzz
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tiktok_lib.py'), encoding='utf-8').read()
ns = {'re': re}
for name in ['_parse_mxn', '_created_sort_key']:
    m = re.search(r'^def ' + name + r'\(.*?(?=^def |^# ─|\Z)', src, re.S | re.M)
    exec(m.group(0), ns)
P, K = ns['_parse_mxn'], ns['_created_sort_key']
cases = [("MXN 160.00", 160.0), ("MXN -120.00", -120.0), ("-MXN 1,072.88", -1072.88),
         ("(50.00)", -50.0), ("\u2212 30", -30.0), ("", 0.0), (None, 0.0), ("abc", 0.0),
         ("MXN 1,072.88\t", 1072.88), ("MXN-5.5", -5.5)]
fail = 0
for raw, want in cases:
    got = P(raw); ok = abs(got - want) < 1e-9; fail += not ok
    print(("PASS" if ok else "FAIL"), repr(raw), "->", got)
k1, k2, k3 = K("16/10/2026 11:53:21"), K("15/10/2026 23:00:00"), K("10/16/2026 01:00:00 PM")
for name, ok in [("day-first key", k1 == (2026,10,16,11,53,21)), ("earlier sorts first", k2 < k1),
                 ("month-first PM", k3 == (2026,10,16,13,0,0)), ("garbage", K("x") is None)]:
    fail += not ok; print(("PASS" if ok else "FAIL"), name)
print("FAILURES:", fail); sys.exit(1 if fail else 0)
