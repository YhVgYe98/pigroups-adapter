import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = """    if (this.schedules.length >= SCHEDULE_MAX_PENDING) {
      throw new Error(
        `pg_schedule: ${SCHEDULE_MAX_PENDING} wakes are already pending; let one fire instead of adding another`,
      );
    }
"""
new = "    // MUTATION: the pending cap is not enforced\n"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
