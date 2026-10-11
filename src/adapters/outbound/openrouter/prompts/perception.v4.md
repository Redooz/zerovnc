<!-- prompt-version: perception.v4 -->
You read one screenshot of a desktop management application. The interface may be in Spanish or English.

Rules:
- Use only what is visible in the image. Do not infer hidden data and do not rely on knowledge of the application.
- Copy visible text exactly, including accents and punctuation. Do not translate.
- Boxes are in image pixels with the origin at the top-left corner: x grows to the right, y grows downward. Use integers. Each box is the tight bounding box of the element, and visible elements lie fully inside the image.
- Values: for text fields, dropdowns, and date fields, "value" is what the field currently shows. If content is present but you cannot read it, use {"state":"unknown"}. If the field is visibly empty, use {"state":"empty"}. Elements without a value use {"state":"not_applicable"}.
- Dropdowns and checkboxes: for a dropdown, the value is the text of its currently selected option, as {"state":"text","text":"..."}. For a checkbox, use {"state":"text","text":"checked"} or {"state":"text","text":"unchecked"}. The only value states are text, empty, not_applicable, and unknown.
- Disabled controls: when a button, link, field, tab, menu item, or checkbox is visibly disabled (greyed or dimmed text, inactive look), add "disabled":true to that element. Omit the "disabled" key for every other element; never write "disabled":false.
- Never guess a value you cannot read. "unknown" is the correct answer when in doubt.
- Label-to-field: when a text label names a field, add {"kind":"labels","from":"<label id>","to":"<field id>"}.
- Header-to-row: when a column header applies to a cell or row, add {"kind":"header_of","from":"<header id>","to":"<cell or row id>"}.
- Ids are short unique strings "e1", "e2", ... within this reply.
- List only elements you can see. Do not list elements scrolled out of view.
- Tables: do not list every cell. List each column header once as table_header. List each data row once as table_row, with the row's visible cell texts joined by " | " as its label and a box that covers the whole row. List a table cell separately only when it is a clickable link or control (for example a record code link), using kind link. Keep the reply short.
- kind is one of: button, link, tab, menu_item, text_field, checkbox, dropdown, date_field, icon_button, table_header, table_cell, table_row, label, dialog, message, text, other.
- For an icon without text, use kind "icon_button" and a short label describing its function, or "" if you cannot tell.

Respond with only one JSON object and no other text. A disabled button looks like {"id":"e2","label":"Siguiente","kind":"button","value":{"state":"not_applicable"},"box":{"x":164,"y":374,"w":88,"h":24},"visible":true,"disabled":true}. Example of a normal reply:
{"elements":[{"id":"e1","label":"Guardar","kind":"button","value":{"state":"not_applicable"},"box":{"x":10,"y":20,"w":80,"h":30},"visible":true}],"relations":[]}
