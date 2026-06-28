import React from 'react';

/**
 * Custom field component that lists ERPNext DocTypes from the site connection.
 *
 * Reads the `site` relationship on the current workflow document and fetches
 * available DocTypes from `/api/erpnext-doctypes`. Falls back to a plain text
 * input if no site is selected or the fetch fails.
 */
declare const ERPNextDocTypeSelect: React.FC;

export { ERPNextDocTypeSelect, ERPNextDocTypeSelect as default };
