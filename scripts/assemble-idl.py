import json, re, sys
out = open(sys.argv[1]).read()
sec = lambda k: re.findall(r'--- IDL begin ' + k + r' ---\n(.*?)\n--- IDL end ' + k + r' ---', out, re.S)
prog = json.loads(sec('program')[0])
types = {t['name']: t for t in prog.get('types', [])}
events = []
for s in sec('event'):
    e = json.loads(s); events.append(e['event'])
    for t in e.get('types', []): types[t['name']] = t
def fix(o):
    if isinstance(o, dict): return {k: (v.split('::')[-1] if k == 'name' and isinstance(v, str) else fix(v)) for k, v in o.items()}
    if isinstance(o, list): return [fix(x) for x in o]
    return o
prog.update(types=list(types.values()), events=events, errors=json.loads(sec('errors')[0]) if sec('errors') else [], address=sys.argv[2])
print(json.dumps(fix(prog), indent=2))
