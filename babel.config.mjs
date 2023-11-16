export default {
  plugins: [
    [
      '@babel/plugin-transform-typescript',
      {
        allowDeclareFields: true,
      },
    ],
    ['@babel/plugin-proposal-decorators', { legacy: true }],
  ],
};
