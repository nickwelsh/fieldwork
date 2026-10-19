import { createFormbraid } from '@formbraid/react';
import { fieldGroups } from './address-group.js';
import { fieldComponents } from './field-components.js';
import { formComponents } from './form-components.js';

const formbraid = createFormbraid({ fieldComponents, formComponents, fieldGroups });

export default formbraid;
export const { Form, useForm } = formbraid;
