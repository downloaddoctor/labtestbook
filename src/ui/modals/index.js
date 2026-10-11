// Modal registry. Import this once; every modal is then opened from any page
// with openModal(name, data). Add a modal = add a file here + one import line.
//
//   import { openModal } from '../modals/index.js';
//   await openModal('patientView', { id });
//
import './patientView.js';
import './payment.js';
import './familyMoney.js';
import './userNew.js';
import './settings.js';
import './textView.js';
import './restorePicker.js';
import './testEdit.js';
import './catalogEdit.js';
import './billView.js';
import './deleteRequests.js';
import './revisions.js';
import './update.js';
export { openModal, defineModal, isModalOpen } from './modal.js';
