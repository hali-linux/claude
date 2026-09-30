import logging

# The helper/web modules log expected failures (wrong passwords, missing
# files, ...) as warnings; keep the test output readable.
logging.getLogger("webterm").setLevel(logging.ERROR)
