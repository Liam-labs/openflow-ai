// Server-side stub for react-window — prevents SSR incompatibility with React 19.
// The actual react-window components are only loaded client-side via next/dynamic({ ssr: false }).
module.exports = {
  VariableSizeList: () => null,
  FixedSizeList: () => null,
  VariableSizeGrid: () => null,
  FixedSizeGrid: () => null,
  areEqual: () => false,
  shouldComponentUpdate: () => true,
};
