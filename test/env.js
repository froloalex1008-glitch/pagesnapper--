/* Imported first by run.js, so it runs before batch.js is evaluated and reads
   process.env.BATCH_DIR. Sends every test's batch output to a scratch folder
   under the OS temp dir instead of the project's real batches/.

   This is not tidiness. run.js deletes the whole batch directory when it is
   done, and before this it deleted the REAL one — so `npm test` started while
   a live client batch was capturing wiped that run's finished screenshots from
   under it. The zip still built, but with folders missing and spreadsheet
   links pointing at files that no longer existed. */
import os from 'node:os';
import path from 'node:path';
process.env.BATCH_DIR = path.join(os.tmpdir(), 'pagesnap-test-batches');
