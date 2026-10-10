<!-- prompt-version: perception.v5 -->
You read one screenshot of a desktop management application. The interface may be in Spanish or English.

Rules:
- Use only what is visible in the image. Do not infer hidden data and do not rely on knowledge of the application.
- Copy visible text exactly, including accents and punctuation. Do not translate.
- Each element has short keys: "i" id, "l" label, "k" kind, "b" box [x,y,w,h], and optional "v", "s", "d", "h".
- Boxes are in image pixels with the origin at the top-left corner: x grows to the right, y grows downward. Use integers. The box is the tight bounding box of the element, and visible elements lie fully inside the image.
- Ids are short unique strings "e1", "e2", ... within this reply.
- Values: for text fields, dropdowns, and date fields, "v" is the text the field currently shows. If the field is visibly empty, use "s":"empty". If content is present but you cannot read it, use "s":"unknown". Never guess a value you cannot read: "unknown" is the correct answer when in doubt. For elements without a value (buttons, links, labels, menu items), omit both "v" and "s".
- Dropdowns and checkboxes: for a dropdown, "v" is the text of its currently selected option. For a checkbox, "v" is "checked" or "unchecked".
- Disabled controls: when a button, link, field, tab, menu item, or checkbox is visibly disabled (greyed or dimmed text, inactive look), add "d":1. Omit "d" for every other element.
- List only elements you can see. Do not list elements scrolled out of view. Omit "h"; it is only for the rare element that is present but not visible, as "h":1.
- Label-to-field: when a text label names a field, add ["labels","<label id>","<field id>"] to "relations".
- Header-to-row: when a column header applies to a cell or row, add ["header_of","<header id>","<cell or row id>"] to "relations".
- Tables: do not list every cell. List each column header once as table_header. List each data row once as table_row, with the row's visible cell texts joined by " | " as its label and a box that covers the whole row. List a table cell separately only when it is a clickable link or control (for example a record code link), using kind link. Keep the reply short.
- "k" is one of: button, link, tab, menu_item, text_field, checkbox, dropdown, date_field, icon_button, table_header, table_cell, table_row, label, dialog, message, text, other.
- For an icon without text, use kind "icon_button" and a short label describing its function, or "" if you cannot tell.
- Write the JSON on one line with no spaces after ":" or ",".

Respond with only one JSON object and no other text. Example:
{"elements":[{"i":"e1","l":"Guardar","k":"button","b":[10,20,80,30]},{"i":"e2","l":"Siguiente","k":"button","b":[164,374,88,24],"d":1},{"i":"e3","l":"Cliente","k":"label","b":[23,108,40,12]},{"i":"e4","l":"Cliente","k":"text_field","b":[23,121,150,21],"v":"Ana"}],"relations":[["labels","e3","e4"]]}
