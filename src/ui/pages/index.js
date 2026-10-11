// Pages registry — router.activateTab(name) looks up Pages[name].{mount,unmount}.

import * as tests from './tests.js';
import * as labs from './labs.js';
import * as doctors from './doctors.js';
import * as bill from './bill.js';
import * as bills from './bills.js';
import * as patients from './patients.js';
import * as ledger from './ledger.js';
import * as users from './users.js';

export const Pages = { tests, labs, doctors, bill, bills, patients, ledger, users };
