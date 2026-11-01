import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = """    if (afterSeconds > SCHEDULE_MAX_SECONDS) {
      throw new Error(`pg_schedule: after_seconds must be at most ${SCHEDULE_MAX_SECONDS} (24 hours)`);
    }
"""
new = "    // MUTATION: no upper bound\n"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
