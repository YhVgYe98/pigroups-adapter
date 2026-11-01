import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = """    if (afterSeconds < SCHEDULE_MIN_SECONDS) {
      throw new Error(`pg_schedule: after_seconds must be at least ${SCHEDULE_MIN_SECONDS} (the tick period)`);
    }
"""
new = "    // MUTATION: no lower bound\n"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
