import { createFieldwork } from '@fieldwork/react';
import { fieldGroups } from './address-group.js';
import { fieldComponents } from './field-components.js';
import { formComponents } from './form-components.js';

const fieldwork = createFieldwork({ fieldComponents, formComponents, fieldGroups });

export default fieldwork;
export const { Form, useForm } = fieldwork;
