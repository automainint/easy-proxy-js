/*  Copyright (c) 2022 Mitya Selivanov
 */ 

'use strict';

async function test_example() {
  return true;
}

let test_count = 0;
let fail_count = 0;

async function add_test(do_test, name) {
  test_count++;

  let success = false;
  let error   = false;

  const time = Date.now();

  try {
    success = await do_test();
  } catch (e) {
    success = false;
    error   = e;
  }

  const time_elapsed = Date.now() - time;
  const spaces       = ' '.repeat(Math.max(0, 40 - name.length));

  if (success) {
    console.log(`[ OK   ] ${name}${spaces} - ${time_elapsed / 1000} sec`);
  } else {
    fail_count++;
    console.log(`[ FAIL ] ${name}${spaces} - ${time_elapsed / 1000} sec`);
  }

  if (error) {
    console.log(error);
  }
}

function run_tests() {
  console.log(`${test_count - fail_count} of ${test_count} tests pass.`);

  await add_test(test_example, "Example test.");

  if (fail_count == 0)
    process.exit(0);
  else
    process.exit(1);
}

run_tests();
