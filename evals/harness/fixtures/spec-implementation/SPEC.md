# Duration format

`parse_duration(text)` returns the number of seconds as an integer.

- One or more number+unit parts with no spaces, for example `45s`, `2h30m`, `1d`.
- Units: `s` (second), `m` (minute), `h` (hour), `d` (day). All lowercase.
- A part is a positive integer, or `0`; `0s` is valid.
- Repeated units are summed: `1h30m` is 5400.
- Empty text, a missing number, an unknown unit, a negative number, or whitespace is invalid and
  raises `ValueError`.
