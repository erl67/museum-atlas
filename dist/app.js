import { createRecordMap, layers, visibleLocations } from './record-map.js';

const byId = id => document.getElementById(id);
const formatter = new Intl.NumberFormat('en-US');
const collator = new Intl.Collator('en', { numeric: true });

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function shape(layer) {
  const symbol = element('span', null, 'shape ' + layer);
  symbol.setAttribute('aria-hidden', 'true');
  return symbol;
}

function action(text, className, callback) {
  const button = element('button', text, className);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

function referenceLink(label, href) {
  const link = element('a', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

export function recordLinks(layer, schema, record) {
  const links = [];
  if (layer === 'eggs') {
    const slip = /^\d/.test(record.id) ? 'E' + record.id : record.id;
    links.push(['View egg slip', 'https://ericlaslo.com/birds/eggs/' + encodeURIComponent(slip)]);
  }
  if (record.database) links.push(['Collection database', record.database]);
  const species = record.species || record.values?.[schema.speciesField];
  if (record.wikipedia) {
    links.push(['Wikipedia article', record.wikipedia]);
  } else if (species && !/^(unknown|unidentified|no specimen|aves)$/i.test(species) && !/\bsp\.?$/i.test(species)) {
    links.push(['Search Wikipedia', 'https://en.wikipedia.org/w/index.php?' + new URLSearchParams({ search: species })]);
  }
  return links;
}

function setDropdown(open) {
  byId('birds-toggle').setAttribute('aria-expanded', String(open));
  byId('bird-options').hidden = !open;
}

function notice(message) {
  byId('notice').textContent = message;
  byId('notice').hidden = !message;
}

function configureGuide() {
  const guide = byId('guide');
  byId('guide-open').onclick = () => guide.showModal();
  byId('guide-close').onclick = () => guide.close();
  guide.addEventListener('click', event => { if (event.target === guide) guide.close(); });
  byId('birds-toggle').onclick = () => setDropdown(byId('bird-options').hidden);
  setDropdown(!matchMedia('(max-width: 650px)').matches);
}

async function openAtlas() {
  configureGuide();
  const enabled = new Set(Object.keys(layers));
  const panel = byId('details');
  let snapshot, cartography, locations, selectedKey, selectedMember;

  function closeDetails(focus = false) {
    panel.hidden = true;
    panel.replaceChildren();
    selectedKey = selectedMember = undefined;
    if (cartography) cartography.select();
    if (focus) cartography.map.getCanvas().focus({ preventScroll: true });
  }

  function show(group, member, focus = true) {
    if (!group) return closeDetails();
    if (!member && group.members.length === 1) member = group.members[0];
    selectedKey = group.key;
    selectedMember = member;
    cartography.select(group.key);
    if (matchMedia('(max-width: 650px)').matches && focus) setDropdown(false);
    const close = action('×', 'close', () => closeDetails(true));
    close.setAttribute('aria-label', 'Close record panel');
    const title = element('h2');
    title.id = 'detail-title';
    title.tabIndex = -1;
    panel.replaceChildren(close);
    if (member) {
      const { layer, record } = member;
      const line = element('div', null, 'record-layer');
      line.append(shape(layer), layers[layer].name);
      title.textContent = record.id;
      panel.append(line, title);
      const fields = element('dl');
      for (const [index, label] of snapshot.layers[layer].labels.entries()) {
        const value = record.values?.[index];
        if (!value) continue;
        const row = element('div', null, 'field');
        row.append(element('dt', label), element('dd', value));
        fields.append(row);
      }
      if (fields.children.length) panel.append(fields);
      if (record.method) panel.append(element('p', 'Approximate position · ' + record.method, 'position'));
      for (const path of record.images || []) {
        const img = element('img', null, 'record-image');
        img.src = './' + path;
        img.alt = 'Collection image for ' + record.id;
        panel.append(img);
      }
      const links = element('nav', null, 'record-links');
      links.setAttribute('aria-label', 'Record references');
      for (const [label, url] of recordLinks(layer, snapshot.layers[layer], record)) links.append(referenceLink(label, url));
      if (links.children.length) panel.append(links);
      if (group.members.length > 1) {
        panel.append(action('All ' + formatter.format(group.members.length) + ' records here', 'back', () => show(group)));
      }
    } else {
      panel.append(element('div', 'Shared location', 'record-layer'));
      title.textContent = formatter.format(group.members.length) + ' records here';
      panel.append(title);
      const list = element('ul', null, 'chooser');
      const sorted = [...group.members].sort((a, b) =>
        Object.keys(layers).indexOf(a.layer) - Object.keys(layers).indexOf(b.layer) || collator.compare(a.record.id, b.record.id));
      for (const entry of sorted) {
        const li = element('li');
        const button = action('', 'chooser-item', () => show(group, entry));
        button.append(shape(entry.layer), layers[entry.layer].name, element('strong', entry.record.id));
        li.append(button);
        list.append(li);
      }
      panel.append(list);
    }
    panel.hidden = false;
    panel.scrollTop = 0;
    if (focus) title.focus({ preventScroll: true });
  }

  function refresh() {
    locations = visibleLocations(snapshot, enabled);
    cartography.replace(locations);
    const count = [...enabled].reduce((sum, name) => sum + snapshot.layers[name].records.length, 0);
    byId('map-count').textContent = formatter.format(count) + (count === 1 ? ' record shown' : ' records shown');
    notice(count ? '' : enabled.size ? 'No mapped records in the selected layers.' : 'Select a layer in Birds to show records.');
    if (selectedKey) {
      const group = locations.get(selectedKey);
      const member = group?.members.find(e => e.layer === selectedMember?.layer && e.record.id === selectedMember?.record.id);
      if (!group || (selectedMember && !member)) closeDetails();
      else show(group, member, false);
    }
  }

  const fetchSnapshot = async () => {
    const response = await fetch('./data/records.json');
    if (!response.ok) throw new Error('Catalogue data returned HTTP ' + response.status);
    return response.json();
  };
  const coordinates = ({ lng, lat }) => {
    byId('coordinates').textContent = Math.abs(lat).toFixed(2) + '° ' + (lat < 0 ? 'S' : 'N') + '   ' +
      Math.abs(lng).toFixed(2) + '° ' + (lng < 0 ? 'W' : 'E');
  };
  [snapshot, cartography] = await Promise.all([
    fetchSnapshot(),
    createRecordMap(byId('map'), group => show(group), coordinates, () => notice('Part of the map could not load. Refresh to try again.')),
  ]);
  byId('demo-label').hidden = snapshot.mode !== 'development';
  for (const [id, layer] of Object.entries(layers)) {
    const label = element('label', null, 'layer');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = true;
    input.name = id;
    input.setAttribute('aria-label', layer.name);
    input.onchange = () => {
      if (input.checked) enabled.add(id);
      else enabled.delete(id);
      refresh();
    };
    label.append(shape(id), element('span', layer.name), element('span', formatter.format(snapshot.layers[id].records.length), 'layer-count'), input);
    byId('layers').append(label);
  }
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !byId('guide').open && !panel.hidden) closeDetails(true);
  });
  refresh();
  return cartography.map;
}

export const ready = openAtlas();
ready.catch(error => {
  console.error(error);
  notice('The atlas could not load. Refresh the page and check that your browser supports WebGL.');
  byId('map-count').textContent = 'Map unavailable';
});
